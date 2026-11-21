import { test, expect } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { hashSecret } from "../../src/hub/auth.js";
import { attachGateway } from "../../src/gateway/service.js";
import { gatewayPiSession } from "../../src/gateway/pi-session.js";
import type { GatewayChannel } from "../../src/gateway/channel.js";
import { createCoreServiceRuntime } from "../../src/core/runtime.js";
import { preparePairing, fixtureInvitation } from "./fixtures/pairing-invite.js";
import { pairingLink } from "../src/pairing-link.js";
import { selectConversation, waitForClientOnline } from "./fixtures/mobile.js";
import type { PiSessionSnapshot, PiSessionChange } from "../../src/client-protocol/pi-session.js";

test.use({ actionTimeout: 15_000 });
for (const width of [390, 1360]) for (const en of [false, true]) test(`Pi conversation controls preserve scope and uncertain request identity · ${width} · ${en ? "en" : "zh"}`, async ({ browser }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "open-super-agent-pi-session-ui-")), stateDir = path.join(root, "bot");
  await mkdir(stateDir); await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "pi", locale: en ? "en" : "zh" }));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") });
  await hub.profile.update({ name: "Demo Host", revision: (await hub.profile.read()).revision });
  const secret = randomBytes(32).toString("base64url");
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('pi_fixture','Pi',?)", [hashSecret(secret)]);
  const gateway = await attachGateway({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", botId: "pi_fixture", secret, engine: "pi", runtime: createCoreServiceRuntime(), bridge: { handleAuthorizedMessage: async () => ({ text: "Pi" }) } });
  const context = await browser.newContext({ viewport: { width, height: 900 }, locale: en ? "en-US" : "zh-CN", serviceWorkers: "block" });
  const page = await context.newPage(), errors: string[] = [], changes: PiSessionChange[] = [], defaultWrites: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const snapshot: PiSessionSnapshot = { supported: true, session: {
    token: "current_worker", model: "first/org/model", modelSource: "native", thinking: "high", thinkingLevels: ["off", "high"],
    choices: ["first", "second"].map(provider => ({ id: `${provider}/org/model`, provider, modelId: "org/model", label: `Native model · ${provider}`, efforts: ["", "off", "high"] })),
    busy: true, bridge: "connected", ui: { title: "Native extension", status: { operation: "Reviewing" }, widgets: { note: { lines: ["A native widget", "<img src=x onerror=alert(1)>"], placement: "aboveEditor" } } },
  } };
  let loseFirstResponse = true, nativeUnknown = false;
  const applied = new Map<string, { outcome: "accepted" | "unknown"; reason?: "uncertain" }>();
  try {
    await hub.store.createConversation("owner", ["pi_fixture"], "Pi session fixture", "pi_session_fixture");
    await page.route("**/api/conversations/*/pi-session*", async route => {
      if (route.request().method() === "GET") return route.fulfill({ json: snapshot });
      const command = route.request().postDataJSON() as PiSessionChange; changes.push(command);
      if (!applied.has(command.requestId)) {
        applied.set(command.requestId, nativeUnknown ? { outcome: "unknown", reason: "uncertain" } : { outcome: "accepted" });
        if (!nativeUnknown) { snapshot.session!.model = command.value!; snapshot.session!.modelSource = "session"; }
      }
      // Native operation succeeded, but its first HTTP reply was lost. Checking
      // the same request reads a receipt rather than executing the change again.
      if (loseFirstResponse) { loseFirstResponse = false; return route.abort("connectionfailed"); }
      return route.fulfill({ json: applied.get(command.requestId) });
    });
    page.on("request", request => { if (request.method() !== "GET" && /\/api\/bots\/[^/]+\/model$/.test(request.url())) defaultWrites.push(request.url()); });
    await page.goto(hub.url);
    if (en) {
      const invitation = await fixtureInvitation(hub);
      await page.getByRole("button", { name: "Paste connection details", exact: true }).click();
      await page.getByLabel("Pairing information", { exact: true }).fill(pairingLink({ v: 1, kind: "connect", hubPublicKey: hub.auth.publicKey, invite: invitation.invite, routes: [{ name: "Direct", url: hub.url }] }));
      await page.getByRole("button", { name: "Use pairing information", exact: true }).click();
    } else await preparePairing(page, hub);
    await page.getByRole("button", { name: en ? "Pair this device" : "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel(en ? "Pairing code" : "配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel(en ? "Pairing code" : "配对码", { exact: true }).waitFor({ state: "hidden" });
    await waitForClientOnline(page);
    if (en && width <= 760) {
      const home = page.locator('.host-workspace:not([hidden]) .mobile-home');
      await home.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: /^Message/ }).click();
      await home.locator(".mh-row").filter({ has: page.getByText("Pi session fixture", { exact: true }) }).click();
    } else await selectConversation(page, "Pi session fixture");
    const trigger = page.getByRole("button", { name: en ? "Pi conversation settings" : "Pi 对话设置", exact: true });
    await trigger.click();
    await expect(page.getByText("A native widget", { exact: false })).toBeVisible();
    const provider = page.getByLabel(en ? "Model provider" : "模型提供商", { exact: true });
    await expect(provider).toBeEnabled(); await provider.selectOption("second");
    const apply = page.getByRole("button", { name: en ? "Apply model" : "应用模型", exact: true });
    await apply.click(); await expect.poll(() => changes.length).toBe(1);
    expect(changes[0]).toMatchObject({ expectedSession: "current_worker", botId: "pi_fixture", action: "model", value: "second/org/model" });
    await expect(page.getByRole("button", { name: en ? "Check change result" : "核对修改结果", exact: true })).toBeVisible();
    await page.getByRole("button", { name: en ? "Close Pi conversation settings" : "关闭 Pi 对话设置", exact: true }).click();
    await trigger.click(); await expect(apply).toBeDisabled();
    await page.getByRole("button", { name: en ? "Check change result" : "核对修改结果", exact: true }).click();
    await expect.poll(() => changes.length).toBe(2); expect(changes[1]).toEqual(changes[0]);
    await expect(page.getByText(en ? "Applied to this Pi conversation." : "已应用到当前 Pi 对话。", { exact: true })).toBeVisible();
    await expect(provider).toHaveValue("second");
    expect(applied.size).toBe(1);
    // A native timeout is permanently unknown, unlike a lost HTTP reply.
    nativeUnknown = true;
    await provider.selectOption("first"); await apply.click();
    await expect.poll(() => changes.length).toBe(3);
    await page.getByRole("button", { name: en ? "Check change result" : "核对修改结果", exact: true }).click();
    await expect.poll(() => changes.length).toBe(4); expect(changes[3]).toEqual(changes[2]);
    await expect(apply).toBeDisabled(); expect(applied.size).toBe(2);
    snapshot.session!.token = "replacement_worker";
    await expect(page.getByRole("button", { name: en ? "Check change result" : "核对修改结果", exact: true })).toHaveCount(0, { timeout: 10_000 });
    await provider.selectOption("first"); await expect(apply).toBeEnabled();
    expect(defaultWrites).toEqual([]); expect(errors).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath("pi-session-controls.png"), fullPage: true });
  } finally { await context.close(); await gateway.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});


test("Pi late response from an unmounted control cannot clear a newer uncertain request", async ({ browser }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "open-super-agent-pi-session-ui-")), stateDir = path.join(root, "bot");
  await mkdir(stateDir); await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "pi", locale: "zh" }));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") });
  await hub.profile.update({ name: "Demo Host", revision: (await hub.profile.read()).revision });
  const secret = randomBytes(32).toString("base64url");
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('pi_fixture','Pi',?)", [hashSecret(secret)]);
  const gateway = await attachGateway({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", botId: "pi_fixture", secret, engine: "pi", runtime: createCoreServiceRuntime(), bridge: { handleAuthorizedMessage: async () => ({ text: "Pi" }) } });
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, locale: "zh-CN", serviceWorkers: "block" });
  const page = await context.newPage(), errors: string[] = [], changes: PiSessionChange[] = [], defaultWrites: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const snapshot: PiSessionSnapshot = { supported: true, session: {
    token: "current_worker", model: "first/org/model", modelSource: "native", thinking: "high", thinkingLevels: ["off", "high"],
    choices: ["first", "second"].map(provider => ({ id: `${provider}/org/model`, provider, modelId: "org/model", label: `Native model · ${provider}`, efforts: ["", "off", "high"] })),
    busy: true, bridge: "connected", ui: { title: "Native extension", status: { operation: "Reviewing" }, widgets: { note: { lines: ["A native widget", "<img src=x onerror=alert(1)>"], placement: "aboveEditor" } } },
  } };
  let releaseFirst: (() => void) | undefined;
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  let firstReplyFinished: (() => void) | undefined;
  const firstReplied = new Promise<void>(resolve => { firstReplyFinished = resolve; });
  try {
    await hub.store.createConversation("owner", ["pi_fixture"], "Pi session fixture", "pi_session_fixture");
    await page.route("**/api/conversations/*/pi-session*", async route => {
      if (route.request().method() === "GET") return route.fulfill({ json: snapshot });
      const command = route.request().postDataJSON() as PiSessionChange; changes.push(command);
      if (changes.length === 1) {
        snapshot.session!.model = command.value!; snapshot.session!.modelSource = "session";
        await firstGate;
        try { await route.fulfill({ json: { outcome: "accepted" } }); } finally { firstReplyFinished!(); }
        return;
      }
      if (changes.length === 2) return route.fulfill({ json: { outcome: "accepted" } });
      return route.fulfill({ json: { outcome: "unknown", reason: "uncertain" } });
    });
    await page.goto(hub.url); await preparePairing(page, hub);
    await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await waitForClientOnline(page); await selectConversation(page, "Pi session fixture");
    const trigger = page.getByRole("button", { name: "Pi 对话设置", exact: true });
    const provider = page.getByLabel("模型提供商", { exact: true });
    const apply = page.getByRole("button", { name: "应用模型", exact: true });
    const check = page.getByRole("button", { name: "核对修改结果", exact: true });
    await trigger.click(); await expect(provider).toBeEnabled(); await provider.selectOption("second");
    await apply.click(); await expect.poll(() => changes.length).toBe(1);
    // Crossing the responsive breakpoint mounts the same controls under a new
    // composer parent. A's old HTTP waiter is deliberately still in progress.
    await page.setViewportSize({ width: 390, height: 900 });
    await expect(page.getByRole("dialog", { name: "Pi 对话设置", exact: true })).toHaveCount(0);
    await trigger.click(); await check.click(); await expect.poll(() => changes.length).toBe(2);
    expect(changes[1]).toEqual(changes[0]);
    await expect(page.getByText("已应用到当前 Pi 对话。", { exact: true })).toBeVisible();
    await expect(provider).toBeEnabled(); await provider.selectOption("first"); await apply.click();
    await expect.poll(() => changes.length).toBe(3); expect(changes[2]!.requestId).not.toBe(changes[0]!.requestId);
    await expect(check).toBeVisible();
    releaseFirst!(); await firstReplied;
    // Let the old fetch callback run, then force a current component read of
    // the shared pending store by closing and reopening the panel.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await page.getByRole("button", { name: "关闭 Pi 对话设置", exact: true }).click(); await trigger.click();
    await expect(check).toBeVisible(); await expect(apply).toBeDisabled();
    await check.click(); await expect.poll(() => changes.length).toBe(4);
    expect(changes[3]).toEqual(changes[2]);
    await expect(apply).toBeDisabled(); expect(errors).toEqual([]);
    await page.screenshot({ path: info.outputPath("pi-pending-owner-preserved.png"), fullPage: true });
  } finally {
    releaseFirst?.(); await context.close(); await gateway.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true });
  }
});


test("Pi uncertain operation stays blocked when receipt verification temporarily loses authorization", async ({ browser }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "open-super-agent-pi-session-ui-")), stateDir = path.join(root, "bot");
  await mkdir(stateDir); await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "pi", locale: "zh" }));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") });
  await hub.profile.update({ name: "Demo Host", revision: (await hub.profile.read()).revision });
  const secret = randomBytes(32).toString("base64url");
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('pi_fixture','Pi',?)", [hashSecret(secret)]);
  const gateway = await attachGateway({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", botId: "pi_fixture", secret, engine: "pi", runtime: createCoreServiceRuntime(), bridge: { handleAuthorizedMessage: async () => ({ text: "Pi" }) } });
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, locale: "zh-CN", serviceWorkers: "block" });
  const page = await context.newPage(), errors: string[] = [], changes: PiSessionChange[] = [], defaultWrites: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const snapshot: PiSessionSnapshot = { supported: true, session: {
    token: "current_worker", model: "first/org/model", modelSource: "native", thinking: "high", thinkingLevels: ["off", "high"],
    choices: ["first", "second"].map(provider => ({ id: `${provider}/org/model`, provider, modelId: "org/model", label: `Native model · ${provider}`, efforts: ["", "off", "high"] })),
    busy: true, bridge: "connected", ui: { title: "Native extension", status: { operation: "Reviewing" }, widgets: { note: { lines: ["A native widget", "<img src=x onerror=alert(1)>"], placement: "aboveEditor" } } },
  } };
  let authorize = true, nativeWrites = 0;
  const receipt = gatewayPiSession({ handleAuthorizedMessage: async () => ({ text: "" }), changePiSession: async () => {
    nativeWrites++; return { outcome: "unknown", reason: "uncertain" };
  } }, { transport: { capabilities: ["pi.session.v1"], requestLive: async () => {
    if (!authorize) throw new Error("temporary authorization transport failure");
    return { allowed: true };
  } }, canSteerConversation: async () => true } as unknown as GatewayChannel, stateDir, "pi_fixture");
  try {
    const conversation = await hub.store.createConversation("owner", ["pi_fixture"], "Pi session fixture", "pi_session_fixture");
    await page.route("**/api/conversations/*/pi-session*", async route => {
      if (route.request().method() === "GET") return route.fulfill({ json: snapshot });
      const command = route.request().postDataJSON() as PiSessionChange; changes.push(command);
      authorize = changes.length !== 2;
      const result = await receipt("pi.session.set", { ...command, conversationId: conversation.id, userId: "owner" });
      return route.fulfill({ json: result });
    });
    await page.goto(hub.url); await preparePairing(page, hub);
    await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await waitForClientOnline(page); await selectConversation(page, "Pi session fixture");
    const trigger = page.getByRole("button", { name: "Pi 对话设置", exact: true });
    const provider = page.getByLabel("模型提供商", { exact: true });
    const apply = page.getByRole("button", { name: "应用模型", exact: true });
    const check = page.getByRole("button", { name: "核对修改结果", exact: true });
    await trigger.click(); await expect(provider).toBeEnabled(); await provider.selectOption("second");
    await apply.click(); await expect(check).toBeEnabled(); expect(nativeWrites).toBe(1);
    await check.click(); await expect.poll(() => changes.length).toBe(2);
    await expect(page.locator(".pi-session-panel [role=alert]")).toBeVisible();
    // A denied verification only describes that retry, not whether A's native
    // write settled. Same-generation controls must remain blocked.
    await page.screenshot({ path: info.outputPath("pi-uncertain-authorize.png"), fullPage: true });
    await expect(check).toBeVisible(); await expect(apply).toBeDisabled();
    await check.click(); await expect.poll(() => changes.length).toBe(3);
    expect(changes[2]).toEqual(changes[0]); expect(nativeWrites).toBe(1);
    await expect(apply).toBeDisabled();
    snapshot.session!.token = "replacement_worker";
    await expect(check).toHaveCount(0, { timeout: 10_000 });
    await expect(provider).toBeEnabled(); expect(errors).toEqual([]);
  } finally { await context.close(); await gateway.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
