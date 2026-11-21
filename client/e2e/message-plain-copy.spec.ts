import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { blocksText, type Block } from "../../src/client-protocol/index.js";
import { preparePairing } from "./fixtures/pairing-invite.js";
import { showDisconnectedBots, selectConversation, waitForClientOnline } from "./fixtures/mobile.js";

// Readable (Markdown-free) message copy: states, lifetimes and entry points
// that the unit suite (tests/client-message-plain-text.test.ts) cannot reach.
const card: Block = { type: "card", title: "**卡片** #标题", elements: [
  { type: "markdown", text: "## 小节\n\n1. **第一**\n2. `code_*`" },
  { type: "collapsible", text: "**详情**", open: true, children: [{ type: "markdown", text: "[文档](https://example.com/a_b)" }] },
  { type: "button", text: "**按钮** _原样_", actionId: "noop" },
] };
const readableCard = "**卡片** #标题\n小节\n\n1. 第一\n2. code_*\n详情\n文档 (https://example.com/a_b)\n**按钮** _原样_";

async function fixture(page: Page, blocks: Block[] = [{ type: "text", text: "# 标题\n\n**重点** 与 `x_*#`" }]) {
  const root = await mkdtemp(path.join(os.tmpdir(), "message-plain-copy-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('copy-bot','复制助手','fixture')");
  const chat = await hub.store.createConversation("owner", ["copy-bot"], "复制验收", "copy-chat");
  const other = await hub.store.createConversation("owner", ["copy-bot"], "另一个对话", "copy-other");
  const message = await hub.store.publishBotMessage("copy-bot", { conversationId: chat.id, blocks });
  await page.goto(hub.url); await preparePairing(page, hub);
  await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
  await showDisconnectedBots(page); await waitForClientOnline(page); await selectConversation(page, chat.title);
  const row = page.locator(`[data-message-id="${message.id}"]`);
  await expect(row).toBeVisible();
  return { hub, chat, other, message, row, close: async () => { await hub.close(); await rm(root, { recursive: true, force: true }); } };
}
/** Clipboard writes stay pending until the test settles them. */
const holdClipboard = (page: Page) => page.evaluate(() => {
  (window as any).copyWrites = [];
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: (text: string) => new Promise<void>((resolve, reject) => {
    (window as any).copyWrites.push({ text, resolve, reject });
  }) } });
});
const recordClipboard = (page: Page) => page.evaluate(() => {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: (text: string) => { (window as any).copied = text; return Promise.resolve(); } } });
});
const writes = (page: Page) => page.evaluate(() => (window as any).copyWrites.length as number);
const frames = (page: Page) => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const sheetOf = (page: Page) => page.getByRole("dialog", { name: "消息操作", exact: true });
async function openSheet(page: Page, row: ReturnType<Page["locator"]>) { await row.focus(); await page.keyboard.press("Enter"); await expect(sheetOf(page)).toBeVisible(); }
/** Only readable-copy conversions fail; message rendering keeps its Worker. */
const breakCopyWorker = (page: Page) => page.addInitScript(() => {
  const Native = window.Worker;
  window.Worker = class extends Native {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      const post = this.postMessage.bind(this);
      this.postMessage = ((data: unknown, ...rest: unknown[]) => {
        if (data && typeof data === "object" && "plain" in data) { queueMicrotask(() => this.dispatchEvent(new ErrorEvent("error"))); return; }
        (post as (...args: unknown[]) => void)(data, ...rest);
      }) as Worker["postMessage"];
    }
  };
});

test("phone copy converts card Markdown fields and keeps titles and button labels literal", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const f = await fixture(page, [card]);
  try {
    await recordClipboard(page);
    await openSheet(page, f.row);
    await sheetOf(page).getByRole("button", { name: "复制消息", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).copied)).toBe(readableCard);
    await expect(f.row.getByText("已复制", { exact: true })).toBeVisible();
    await openSheet(page, f.row);
    await sheetOf(page).getByRole("button", { name: "选择文本", exact: true }).click();
    await expect(sheetOf(page).getByRole("textbox", { name: "可选择的消息文本", exact: true })).toHaveValue(readableCard);
    await expect(sheetOf(page).getByRole("status")).toHaveCount(0);
    expect((await f.hub.store.messageForUser("owner", f.message.id)).blocks).toEqual([card]);
  } finally { await f.close(); }
});

test("a copy result that arrives after leaving the conversation and returning shows no feedback", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const f = await fixture(page);
  try {
    await holdClipboard(page);
    for (const outcome of ["resolve", "reject"] as const) {
      await openSheet(page, f.row);
      await sheetOf(page).getByRole("button", { name: "复制消息", exact: true }).click();
      const pending = outcome === "resolve" ? 1 : 2;
      await expect.poll(() => writes(page)).toBe(pending);
      await selectConversation(page, f.other.title); await selectConversation(page, f.chat.title);
      await expect(f.row).toBeVisible();
      await page.evaluate(([index, kind]) => (window as any).copyWrites[index as number][kind as string](new Error("fixture-late-copy")), [pending - 1, outcome]);
      await frames(page);
      await expect(f.row.getByText("已复制", { exact: true })).toHaveCount(0);
      await expect(page.getByRole("alert").filter({ hasText: /无法写入剪贴板|未能整理格式/ })).toHaveCount(0);
    }
    // The write itself was not withdrawn: it carried the readable text the tap saw.
    expect(await page.evaluate(() => (window as any).copyWrites.map((write: { text: string }) => write.text))).toEqual(["标题\n\n重点 与 x_*#", "标题\n\n重点 与 x_*#"]);
  } finally { await f.close(); }
});

test("a copy refused after its message was deleted reports nothing", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const f = await fixture(page);
  try {
    await holdClipboard(page);
    await openSheet(page, f.row);
    await sheetOf(page).getByRole("button", { name: "复制消息", exact: true }).click();
    await expect.poll(() => writes(page)).toBe(1);
    await f.hub.store.deleteMessages("owner", f.chat.id, { messageIds: [f.message.id] });
    await expect(f.row.locator(".markdown")).toHaveCount(0);
    await page.evaluate(() => (window as any).copyWrites[0].reject(new Error("fixture-late-copy")));
    await frames(page);
    await expect(page.getByRole("alert").filter({ hasText: /无法写入剪贴板|未能整理格式/ })).toHaveCount(0);
  } finally { await f.close(); }
});

test("unavailable conversion copies and shows the complete original text, and says so", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await breakCopyWorker(page);
  const source = "# 标题\n\n**重点** 与 `x_*#`";
  const f = await fixture(page);
  try {
    // Rendering is unaffected by the copy Worker's failure.
    await expect(f.row.locator("h1")).toHaveText("标题");
    await recordClipboard(page);
    await openSheet(page, f.row);
    await sheetOf(page).getByRole("button", { name: "复制消息", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).copied)).toBe(source);
    await expect(page.getByRole("alert").filter({ hasText: "未能整理格式，已复制原文。" })).toBeVisible();
    await expect(f.row.getByText("已复制", { exact: true })).toBeVisible();
    await openSheet(page, f.row);
    await sheetOf(page).getByRole("button", { name: "选择文本", exact: true }).click();
    const field = sheetOf(page).getByRole("textbox", { name: "可选择的消息文本", exact: true });
    await expect(field).toHaveValue(source);
    await expect(sheetOf(page).getByRole("status")).toHaveText("未能整理格式，以下为原文。");
    await expect(field).toBeFocused();
  } finally { await f.close(); }
});

test("selectable text follows a streaming message without replacing the reader's selection", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const f = await fixture(page);
  try {
    await openSheet(page, f.row);
    await sheetOf(page).getByRole("button", { name: "选择文本", exact: true }).click();
    const field = sheetOf(page).getByRole("textbox", { name: "可选择的消息文本", exact: true });
    await expect(field).toHaveValue("标题\n\n重点 与 x_*#");
    await expect(field).toBeFocused();
    // Opening selects everything once.
    expect(await field.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd])).toEqual([0, "标题\n\n重点 与 x_*#".length]);
    await field.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(0, 2));
    await f.hub.store.publishBotMessage("copy-bot", { id: f.message.id, conversationId: f.chat.id, blocks: [{ type: "text", text: "# 标题\n\n**重点** 与 `x_*#`\n\n- 新增 *一行*" }] });
    await expect(field).toHaveValue("标题\n\n重点 与 x_*#\n\n• 新增 一行");
    // The update neither blanked the field nor selected everything again.
    expect(await field.evaluate((el: HTMLTextAreaElement) => el.selectionEnd - el.selectionStart)).toBeLessThan("标题\n\n重点 与 x_*#\n\n• 新增 一行".length);
    await expect(sheetOf(page).getByRole("status")).toHaveCount(0);
    // Another message never shows this one's text.
    await page.keyboard.press("Escape");
    const next = await f.hub.store.publishBotMessage("copy-bot", { conversationId: f.chat.id, blocks: [{ type: "text", text: "第二条 **消息**" }] });
    const row = page.locator(`[data-message-id="${next.id}"]`);
    await expect(row).toBeVisible(); await openSheet(page, row);
    await sheetOf(page).getByRole("button", { name: "选择文本", exact: true }).click();
    const second = sheetOf(page).getByRole("textbox", { name: "可选择的消息文本", exact: true });
    await expect(second).toHaveValue("第二条 消息");
    // Removed while selecting: the sheet says so instead of keeping stale text.
    await f.hub.store.deleteMessages("owner", f.chat.id, { messageIds: [next.id] });
    await expect(sheetOf(page).getByText("这条消息已不在当前对话中，可能已被删除。", { exact: true })).toBeVisible();
    await expect(second).toHaveCount(0);
  } finally { await f.close(); }
});

for (const platform of ["android", "web"] as const) {
  test(`${platform} wide context menu copies the whole message by platform and selected text natively`, async ({ page }) => {
    const source = "# 标题\n\n**重点** 与 `x_*#`";
    const f = await fixture(page);
    try {
      await page.evaluate(platform => { if (platform !== "web") (window as any).Capacitor.getPlatform = () => platform; }, platform);
      await recordClipboard(page);
      const menu = page.getByRole("menu", { name: "消息操作", exact: true });
      await f.row.locator(".markdown p").click({ button: "right" });
      await menu.getByRole("menuitem", { name: "复制消息", exact: true }).click();
      await expect.poll(() => page.evaluate(() => (window as any).copied)).toBe(platform === "web" ? source : "标题\n\n重点 与 x_*#");
      expect(blocksText((await f.hub.store.messageForUser("owner", f.message.id)).blocks)).toBe(source);
      // A rendered selection is copied as selected on every platform.
      await f.row.locator(".markdown strong").evaluate(el => { const range = document.createRange(); range.selectNodeContents(el); const s = document.getSelection()!; s.removeAllRanges(); s.addRange(range); });
      await f.row.locator(".markdown strong").click({ button: "right" });
      await menu.getByRole("menuitem", { name: "复制所选文本", exact: true }).click();
      await expect.poll(() => page.evaluate(() => (window as any).copied)).toBe("重点");
    } finally { await f.close(); }
  });
}
