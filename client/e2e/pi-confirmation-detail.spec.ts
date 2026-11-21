import { test, expect } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { hashSecret } from "../../src/hub/auth.js";
import { attachGateway } from "../../src/gateway/service.js";
import { createCoreServiceRuntime } from "../../src/core/runtime.js";
import { piDialogQuestion, piDialogResponse } from "../../src/codex/pi-turn-mapper.js";
import { pairingLink } from "../src/pairing-link.js";
import { fixtureInvitation } from "./fixtures/pairing-invite.js";
import { waitForClientOnline } from "./fixtures/mobile.js";

for (const [locale, width] of [["en", 390], ["zh", 1360]] as const) {
  test(`Pi confirmation shows the affected scope before an answer · ${locale} · ${width}`, async ({ browser }) => {
    const en = locale === "en", root = await mkdtemp(path.join(os.tmpdir(), "open-super-agent-pi-confirm-"));
    const stateDir = path.join(root, "bot");
    await mkdir(stateDir);
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "pi", locale }));
    const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") });
    await hub.profile.update({ name: "Demo Host", revision: (await hub.profile.read()).revision });
    const secret = randomBytes(32).toString("base64url");
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('pi_confirm','Pi',?)", [hashSecret(secret)]);
    const request = { type: "extension_ui_request", id: "scope-confirmation", method: "confirm",
      title: en ? "Confirm global setting" : "确认全局设置",
      message: en ? "This changes every Pi session on this computer, including sessions in the terminal." : "这会修改此电脑上的所有 Pi 会话，包括终端中的会话。" } as const;
    const question = piDialogQuestion(request, locale)!;
    const answers: unknown[] = [];
    const gateway = await attachGateway({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", botId: "pi_confirm", secret,
      engine: "pi", runtime: createCoreServiceRuntime(), bridge: { handleAuthorizedMessage: async input => {
        const answer = await input.onApprovalRequest?.({ engine: "pi", toolName: "AskUserQuestion", toolInput: { questions: [question] } });
        answers.push(piDialogResponse(request, question, answer?.behavior === "allow" ? answer.updatedInput : undefined, locale));
        return { text: "Confirmation received" };
      } } });
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: en ? "en-US" : "zh-CN", serviceWorkers: "block" });
    const page = await context.newPage();
    try {
      await hub.store.createConversation("owner", ["pi_confirm"], "Pi confirmation fixture", "pi_confirmation");
      await page.goto(hub.url);
      const invitation = await fixtureInvitation(hub);
      await page.getByRole("button", { name: en ? "Paste connection details" : "粘贴连接信息", exact: true }).click();
      await page.getByLabel(en ? "Pairing information" : "配对信息", { exact: true }).fill(pairingLink({ v: 1, kind: "connect", hubPublicKey: hub.auth.publicKey, invite: invitation.invite, routes: [{ name: "Direct", url: hub.url }] }));
      await page.getByRole("button", { name: en ? "Use pairing information" : "使用配对信息", exact: true }).click();
      await page.getByRole("button", { name: en ? "Pair this device" : "配对此设备", exact: true }).click();
      await hub.auth.approve(await page.getByLabel(en ? "Pairing code" : "配对码", { exact: true }).innerText(), "local-owner");
      await page.getByLabel(en ? "Pairing code" : "配对码", { exact: true }).waitFor({ state: "hidden" });
      await waitForClientOnline(page);
      if (width <= 760) {
        const home = page.locator('.host-workspace:not([hidden]) .mobile-home');
        await home.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: /^Message/ }).click();
        await home.locator(".mh-row").filter({ has: page.getByText("Pi confirmation fixture", { exact: true }) }).click();
      } else {
        await page.getByText("Pi confirmation fixture", { exact: true }).filter({ visible: true }).first().click();
      }
      await page.getByRole("textbox", { name: en ? "Message" : "消息", exact: true }).fill("Confirm scope");
      await page.getByRole("button", { name: en ? "Send message" : "发送消息", exact: true }).click();
      const form = page.locator(".native-question").filter({ visible: true });
      await expect(form).toContainText(request.title);
      await expect(form).toContainText(request.message);
      expect(answers).toEqual([]);
      expect(await form.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      await form.getByRole("radio", { name: en ? "No" : "否", exact: true }).check();
      await form.getByRole("button", { name: en ? "Submit" : "提交", exact: true }).click();
      await expect.poll(() => answers).toEqual([{ type: "extension_ui_response", id: request.id, confirmed: false }]);
    } finally {
      await context.close(); await gateway.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true });
    }
  });
}
