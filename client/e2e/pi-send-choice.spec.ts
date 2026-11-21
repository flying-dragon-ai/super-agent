import { test, expect, type Page } from "@playwright/test";
import { fixtureInvitation, preparePairing } from "./fixtures/pairing-invite.js";
import { selectConversation, waitForClientOnline } from "./fixtures/mobile.js";
import { pairingLink } from "../src/pairing-link.js";
import { piSendChoiceFixture } from "./fixtures/pi-send-choice.js";

test.use({ serviceWorkers: "block", actionTimeout: 12_000 });
async function open(page: Page, fixture: Awaited<ReturnType<typeof piSendChoiceFixture>>) {
  await page.goto(fixture.hub.url); await preparePairing(page, fixture.hub);
  await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await fixture.hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
  await selectConversation(page, fixture.chats[0]!.title);
  const input = page.getByRole("textbox", { name: "消息", exact: true });
  await input.fill("开始检查"); await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect.poll(() => fixture.turns.length).toBe(1);
  await expect(page.locator('.claude-send-choice [data-mode="current"]')).toBeChecked();
  return input;
}

test("Pi uncertain input cannot be duplicated by choosing the next turn or reloading", async ({ page }) => {
  const fixture = await piSendChoiceFixture();
  try {
    const input = await open(page, fixture), send = page.getByRole("button", { name: "发送消息", exact: true });
    fixture.options.loseAdmission = true;
    await input.fill("只处理一次的补充"); await send.click();
    await expect(page.locator(".steering-receipt")).toContainText("待确认");
    await expect(send).toBeEnabled();
    await page.locator('.claude-send-choice [data-mode="next"]').check();
    await expect(page.locator('.composer-hint')).toHaveText('等待当前任务结束后再处理');
    await send.click();
    await expect(page.locator(".error-banner")).toContainText("本次未重复排队");
    await expect(input).toHaveValue("只处理一次的补充");
    await expect(page.getByRole("button", { name: /管理待执行消息/ })).toHaveCount(0);
    await page.reload(); await expect(input).toHaveValue("只处理一次的补充");
    await send.click(); await expect(page.locator(".steering-receipt")).toContainText("待确认");
    expect(fixture.inputs).toEqual(["只处理一次的补充"]);
    fixture.finish(); await expect(page.getByText("本轮已完成。", { exact: true })).toBeVisible();
    await send.click(); await expect(page.locator(".error-banner")).toContainText("本次未重复排队");
    expect(fixture.turns).toHaveLength(1);
  } finally { await page.close(); await fixture.close(); }
});

test("Pi native live commands reach the running task, while App commands retain their route", async ({ page }) => {
  const fixture = await piSendChoiceFixture();
  try {
    const input = await open(page, fixture), send = page.getByRole("button", { name: "发送消息", exact: true });
    await input.fill("/thinking high"); await send.click();
    await expect.poll(() => fixture.inputs).toEqual(["/thinking high"]);
    await expect(input).toHaveValue("");
    await expect(page.getByRole("button", { name: /管理待执行消息/ })).toHaveCount(0);
    await input.fill("/help"); await send.click(); await expect(input).toHaveValue("");
    expect(fixture.inputs).toEqual(["/thinking high"]);
  } finally { await page.close(); await fixture.close(); }
});

for (const width of [390, 1360]) for (const english of [false, true]) test(`Pi native command menu stays reachable and scoped · ${width} · ${english ? "en" : "zh"}`, async ({ browser }) => {
  const fixture = await piSendChoiceFixture();
  const context = await browser.newContext({ viewport: { width, height: 850 }, locale: english ? "en-US" : "zh-CN", serviceWorkers: "block" });
  const page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    await page.goto(fixture.hub.url);
    if (english) {
      const invitation = await fixtureInvitation(fixture.hub);
      await page.getByRole("button", { name: "Paste connection details", exact: true }).click();
      await page.getByLabel("Pairing information", { exact: true }).fill(pairingLink({ v: 1, kind: "connect", hubPublicKey: fixture.hub.auth.publicKey, invite: invitation.invite, routes: [{ name: "Direct", url: fixture.hub.url }] }));
      await page.getByRole("button", { name: "Use pairing information", exact: true }).click();
    } else await preparePairing(page, fixture.hub);
    await page.getByRole("button", { name: english ? "Pair this device" : "配对此设备", exact: true }).click();
    const code = page.getByLabel(english ? "Pairing code" : "配对码", { exact: true });
    await fixture.hub.auth.approve(await code.innerText(), "local-owner"); await code.waitFor({ state: "hidden" });
    await waitForClientOnline(page);
    if (english && width <= 760) {
      const home = page.locator('.host-workspace:not([hidden]) .mobile-home');
      await home.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: /^Message/ }).click();
      await home.locator(".mh-row").filter({ has: page.getByText(fixture.chats[0]!.title, { exact: true }) }).click();
    } else await selectConversation(page, fixture.chats[0]!.title);
    const input = page.getByRole("textbox", { name: english ? "Message" : "消息", exact: true }), menu = page.locator(".command-menu");
    await input.fill("/think");
    await expect(menu.getByRole("button", { name: /^\/thinking\s/ })).toContainText(english ? "conversation" : "当前对话");
    await menu.getByRole("button", { name: /^\/thinking\s/ }).click();
    await expect(input).toHaveValue("/thinking "); await expect(input).toBeFocused();
    await input.fill("/model"); await expect(menu.getByRole("button", { name: /^\/model\s/ })).toContainText(english ? "conversation" : "当前对话");
    await input.fill("/login"); await expect(menu.getByRole("button", { name: /^\/login\s/ })).toContainText(english ? "terminal" : "终端");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  } finally { await context.close(); await fixture.close(); }
});

for (const width of [390, 1360]) test(`Pi session commands stay scoped, templates steer, and extensions queue as owned turns · ${width}`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 850 });
  const fixture = await piSendChoiceFixture();
  const snapshot = { supported: true, session: { token: "worker", modelSource: "native", thinking: "off", thinkingLevels: ["off"], choices: [], busy: true, bridge: "connected", ui: { status: {}, widgets: {} }, commands: [
    { name: "review:2", source: "extension", description: "Native extension command" },
    { name: "skill:lab", source: "skill", description: "Native skill" },
    { name: "template", source: "prompt", description: "Native template" },
    { name: "help", source: "extension", description: "Must not replace App help" },
    { name: "command-name-".repeat(8), source: "extension", description: "AnUnbrokenDescription".repeat(20) },
  ] } };
  try {
    await page.route("**/api/conversations/*/pi-session*", route => route.fulfill({ json: route.request().url().includes(`/${fixture.chats[0]!.id}/`) ? snapshot : { supported: true } }));
    const input = await open(page, fixture), menu = page.locator(".command-menu");
    for (const command of ["skill:lab", "template"]) {
      await input.fill(`/${command}`);
      await expect(menu.getByRole("button", { name: new RegExp(`^/${command}\\s`) })).toBeVisible();
      await input.fill(`/${command} check`); await page.getByRole("button", { name: "发送消息", exact: true }).click();
      await expect.poll(() => fixture.inputs.at(-1)).toBe(`/${command} check`); await expect(input).toHaveValue("");
    }
    await input.fill("/review:2"); await expect(menu.getByRole("button", { name: /^\/review:2\s/ })).toBeVisible();
    await input.fill("/review:2 check");
    await expect(page.locator(".composer-hint")).toHaveText("普通发送将排队");
    await expect(page.getByRole("button", { name: "引导当前任务", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "发送消息", exact: true }).click(); await expect(input).toHaveValue("");
    await expect(page.getByRole("button", { name: /管理待执行消息/ })).toBeVisible();
    expect(fixture.inputs).toEqual(["/skill:lab check", "/template check"]);
    fixture.finish(); await expect.poll(() => fixture.turns).toEqual(["开始检查", "/review:2 check"]);
    await input.fill("/command-name"); await expect(menu).toBeVisible();
    expect(await menu.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath("pi-native-command-menu.png"), fullPage: true });
    expect((await menu.getByRole("button").first().boundingBox())!.height).toBeLessThan(100);
    await input.fill("/help"); await expect(menu).not.toContainText("Must not replace App help");
    await input.fill("");
    await selectConversation(page, fixture.chats[1]!.title);
    await input.fill("/review"); await expect(menu).toHaveCount(0);
    expect(fixture.inputs).toEqual(["/skill:lab check", "/template check"]);
  } finally { await page.close(); await fixture.close(); }
});

for (const edited of [false, true]) test(`Pi definite rejection safely queues only an unchanged draft · edited=${edited}`, async ({ page }) => {
  const fixture = await piSendChoiceFixture();
  try {
    const input = await open(page, fixture); fixture.options.rejectAdmission = true;
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const posted = new Promise<void>(resolve => { started = resolve; });
    await page.route('**/api/conversations/*/steer', async route => {
      if (route.request().method() === 'POST') { started(); await gate; }
      await route.continue();
    });
    await input.fill('收尾时的补充'); await page.getByRole('button', { name: '发送消息', exact: true }).click(); await posted;
    if (edited) await input.fill('修改后的草稿'); release();
    if (edited) {
      await expect(page.locator('.error-banner')).toContainText('内容已修改');
      await expect(input).toHaveValue('修改后的草稿');
      await expect(page.getByRole('button', { name: /管理待执行消息/ })).toHaveCount(0);
    } else {
      await expect(input).toHaveValue('');
      await expect(page.getByRole('button', { name: /管理待执行消息/ })).toBeVisible();
      fixture.finish(); await expect.poll(() => fixture.turns).toEqual(['开始检查', '收尾时的补充']);
    }
    expect(fixture.inputs).toEqual(['收尾时的补充']);
  } finally { await page.close(); await fixture.close(); }
});

for (const navigate of [false, true]) test(`Pi editing during confirmed admission preserves the new draft and permits an intentional later repeat · navigate=${navigate}`, async ({ page }) => {
  const fixture = await piSendChoiceFixture();
  try {
    const input = await open(page, fixture);
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), posted = new Promise<void>(resolve => { started = resolve; });
    await page.route('**/api/conversations/*/steer', async route => {
      if (route.request().method() === 'POST') { started(); await gate; }
      await route.continue();
    });
    await input.fill('再次核对'); await page.getByRole('button', { name: '发送消息', exact: true }).click(); await posted;
    await input.fill('另一条草稿');
    if (navigate) { await selectConversation(page, fixture.chats[1]!.title); await input.fill('其他对话草稿'); }
    release();
    await expect.poll(() => fixture.inputs.length).toBe(1);
    if (navigate) {
      // The POST completed while the source chat was not selected.
      await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled();
      await selectConversation(page, fixture.chats[0]!.title);
    }
    await expect(page.locator('.steering-receipt.accepted')).toBeVisible();
    await expect(input).toHaveValue('另一条草稿');
    await input.fill('再次核对'); await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect.poll(() => fixture.inputs).toEqual(['再次核对', '再次核对']);
  } finally { await page.close(); await fixture.close(); }
});
