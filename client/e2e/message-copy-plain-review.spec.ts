import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { preparePairing } from "./fixtures/pairing-invite.js";
import { showDisconnectedBots, selectConversation, waitForClientOnline } from "./fixtures/mobile.js";

const source = [
  "# 中文与 English", "", "**重点**与 *emphasis*", "",
  "[说明](https://example.com/help?q=one_two#part)", "",
  "```text", "# literal **stars** _underscores_", "  keep indentation", "```", "",
  "| 名称 | Value |", "| --- | --- |", "| 苹果 | 42 |",
].join("\n");

async function fixture(page: Page) {
  const root = await mkdtemp(path.join(os.tmpdir(), "message-copy-plain-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('copy-bot','复制助手','fixture')");
  const chat = await hub.store.createConversation("owner", ["copy-bot"], "复制验收", "copy-chat");
  const message = await hub.store.publishBotMessage("copy-bot", { conversationId: chat.id, blocks: [{ type: "text", text: source }] });
  await page.goto(hub.url); await preparePairing(page, hub);
  await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
  await showDisconnectedBots(page); await waitForClientOnline(page); await selectConversation(page, chat.title);
  return { hub, chat, message, row: page.locator(`[data-message-id="${message.id}"]`), close: async () => { await hub.close(); await rm(root, { recursive: true, force: true }); } };
}

function expectReadable(text: string) {
  expect(text).toContain("中文与 English");
  expect(text).not.toContain("# 中文");
  expect(text).toContain("重点与 emphasis");
  expect(text).not.toContain("**重点**");
  expect(text).toContain("https://example.com/help?q=one_two#part");
  expect(text).toContain("# literal **stars** _underscores_\n  keep indentation");
  expect(text).not.toContain("```text");
  expect(text).toContain("名称\tValue\n苹果\t42");
}

test("phone message copy and native selected-text paste preserve readable content and literal code", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const f = await fixture(page);
  try {
    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: (text: string) => {
        (window as any).copyReadback = { text, active: navigator.userActivation.isActive };
        return Promise.resolve();
      } } });
    });
    await f.row.focus(); await page.keyboard.press("Enter");
    const sheet = page.getByRole("dialog", { name: "消息操作", exact: true });
    await sheet.getByRole("button", { name: "复制消息", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).copyReadback)).toBeTruthy();
    const readback = await page.evaluate(() => (window as any).copyReadback);
    expectReadable(readback.text); expect(readback.active).toBe(true);
    await f.row.focus(); await page.keyboard.press("Enter");
    await sheet.getByRole("button", { name: "选择文本", exact: true }).click();
    const field = sheet.getByRole("textbox", { name: "可选择的消息文本", exact: true });
    await expect(field).toHaveValue(readback.text);
    await field.selectText();
    await page.keyboard.press("ControlOrMeta+C");
    await page.keyboard.press("Escape");
    const composer = page.getByRole("textbox", { name: "消息", exact: true });
    await composer.click(); await page.keyboard.press("ControlOrMeta+V");
    await expect(composer).toHaveValue(readback.text);
  } finally { await f.close(); }
});

for (const platform of ["ios", "android", "web"] as const) {
  test(`${platform} wide message copy uses the platform policy without changing stored blocks`, async ({ page }) => {
    const f = await fixture(page);
    try {
      await page.evaluate(platform => {
        if (platform !== "web") (window as any).Capacitor.getPlatform = () => platform;
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: (text: string) => {
          (window as any).copyReadback = { text, active: navigator.userActivation.isActive };
          return Promise.resolve();
        } } });
      }, platform);
      // Re-render the workspace after the synthetic platform change.
      await page.getByRole("textbox", { name: "消息", exact: true }).fill("草稿");
      await f.row.hover();
      await f.row.getByRole("button", { name: "复制消息", exact: true }).click();
      await expect.poll(() => page.evaluate(() => (window as any).copyReadback)).toBeTruthy();
      const readback = await page.evaluate(() => (window as any).copyReadback);
      if (platform === "web") expect(readback.text).toBe(source);
      else expectReadable(readback.text);
      expect(readback.active).toBe(true);
      expect((await f.hub.store.messageForUser("owner", f.message.id)).blocks).toEqual([{ type: "text", text: source }]);
    } finally { await f.close(); }
  });
}

test("an earlier copy rejection cannot erase the newer message's success", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const f = await fixture(page);
  try {
    await page.evaluate(() => {
      (window as any).copyWrites = [];
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: () => new Promise<void>((resolve, reject) => {
        (window as any).copyWrites.push({ resolve, reject });
      }) } });
    });
    const copy = async (row: typeof f.row) => {
      await row.focus(); await page.keyboard.press("Enter");
      await page.getByRole("dialog", { name: "消息操作", exact: true }).getByRole("button", { name: "复制消息", exact: true }).click();
    };
    await copy(f.row);
    await expect.poll(() => page.evaluate(() => (window as any).copyWrites.length)).toBe(1);
    const next = await f.hub.store.publishBotMessage("copy-bot", { conversationId: f.chat.id, blocks: [{ type: "text", text: "Second **message**" }] });
    const row = page.locator(`[data-message-id="${next.id}"]`);
    await expect(row).toBeVisible(); await copy(row);
    await expect.poll(() => page.evaluate(() => (window as any).copyWrites.length)).toBe(2);
    await page.evaluate(() => (window as any).copyWrites[1].resolve());
    await expect(row.getByText("已复制", { exact: true })).toBeVisible();
    await page.evaluate(() => (window as any).copyWrites[0].reject(new Error("fixture-old-copy-denied")));
    // Flush the rejected write's promise chain before asserting the still-current feedback.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(row.getByText("已复制", { exact: true })).toBeVisible();
    await expect(page.getByRole("alert").filter({ hasText: "无法写入剪贴板" })).toHaveCount(0);
  } finally { await f.close(); }
});
