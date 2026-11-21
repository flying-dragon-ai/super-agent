import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { selectConversation, showDisconnectedBots, waitForClientOnline } from "./fixtures/mobile.js";
import { closeSettings, openSettings } from "./fixtures/settings.js";

// Synthetic content only: a reply whose seven-column table needs more than the
// 760px reading width, and filler replies tall enough to virtualize.
const table = [
  "| 方式 | 谁来构建 | 发布触发 | 自定义域名 | 回滚 | 适合场景 | 主要限制 |",
  "| --- | --- | --- | --- | --- | --- | --- |",
  "| 平台自带页面服务 | 平台 | 推送分支 | 支持，证书自动 | 重新发布旧提交 | 文档站、个人主页、更新不频繁的官网 | 构建环境固定，缓存策略可调的不多 |",
  "| 对象存储 + CDN | 自己的流水线 | 脚本上传 | 支持，证书自管 | 切回上一版目录 | 访问量大、需要精细控制缓存的站点 | 发布、刷新缓存、回滚脚本都要自己维护 |",
  "| 边缘函数平台 | 平台 | 推送或命令行 | 支持，证书自动 | 一键切换历史版本 | 带少量动态逻辑或按地区分流的页面 | 运行时有限制，纯静态内容用不上 |",
  "| 自建容器 + Nginx | 自己的流水线 | 镜像发布 | 支持，证书自管 | 回退镜像标签 | 已有容器平台、要和内部服务放一起 | 要自己负责可用性、扩容和证书续期 |",
].join("\n");
const report = `**四种方式都能上线，差别主要在“谁来构建”和“出问题时怎么退回”。**下面先给结论，再用一张表把构建、域名、回滚、适合场景和主要限制放在一起；表格列比较多，窄的时候需要左右滑动才能看全。\n\n${table}\n\n**建议：**先用平台自带的页面服务上线；等访问量或缓存要求上来，再迁到对象存储加 CDN。迁移时只需要改发布脚本和域名解析，站点内容本身不用动。`;
const wideTable = [`| ${Array.from({ length: 16 }, (_, i) => `指标 ${i + 1}`).join(" | ")} |`, `| ${Array.from({ length: 16 }, () => "---").join(" | ")} |`,
  ...Array.from({ length: 3 }, (_, row) => `| ${Array.from({ length: 16 }, (_, i) => `第 ${row + 1} 行数值 ${i + 1}`).join(" | ")} |`)].join("\n");
const filler = (index: number, lines = 3) => Array.from({ length: lines }, (_, line) => `第 ${index} 条记录，第 ${line + 1} 段：这里是一段足够长的示例文字，用来让这条回复在阅读宽度下折成几行，并且在加宽以后明显变矮；内容只是占位，没有实际含义。`).join("\n\n");

type Reply = { phase?: "done" | "working"; revision?: number; scoped?: boolean };
async function start() {
  const root = await mkdtemp(path.join(os.tmpdir(), "reply-width-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  await hub.profile.update({ name: "演示主机", revision: (await hub.profile.read()).revision });
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,online) VALUES('alpha','资料助手','fixture',1)");
  const chat = (title: string) => hub.store.createConversation("owner", ["alpha"], title, title);
  const reply = (conversationId: string, id: string, text: string, { phase = "done", revision = 1, scoped = false }: Reply = {}) => {
    const at = Date.now(), run = { id: `run-${id}`, version: 1, revision, phase, startedAt: at - 128_000, updatedAt: at, ...(phase === "done" ? { endedAt: at } : {}), count: 12, completed: phase === "done" ? 12 : 3, failed: 0, truncated: false };
    return hub.store.publishBotMessage("alpha", { id, conversationId, status: phase === "done" ? "complete" : "streaming", blocks: [{ type: "card", elements: [{ type: "markdown", text: "运行状态" }, { type: "markdown", text }],
      extra: scoped ? { scopedRun: run, backgroundTask: { version: 1, origin: "bound" } } : { nativeRun: run } }] });
  };
  const ask = async (conversationId: string, text: string) => (await hub.store.sendMessage("owner", { conversationId, clientMsgId: "prompt", text, attachments: [] })).message;
  return { hub, chat, reply, ask, close: async () => { await hub.close(); await rm(root, { recursive: true, force: true }); } };
}
async function pair(page: Page, hub: HubServer) {
  await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await showDisconnectedBots(page); await waitForClientOnline(page);
}
const row = (page: Page, id: string) => page.locator(`article[data-message-id="${id}"]`);
const toggle = (page: Page, id: string) => row(page, id).locator(".native-run-width");
/** Measured in the page, in viewport pixels. */
const layout = (page: Page) => page.evaluate(() => {
  const scroll = document.querySelector<HTMLElement>(".message-scroll")!, list = scroll.querySelector<HTMLElement>(".virtual-messages")!;
  const rect = (node: Element) => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
  const rows = [...list.querySelectorAll<HTMLElement>("article[data-message-id]")].sort((a, b) => Number(a.dataset.index) - Number(b.dataset.index));
  return {
    room: scroll.hasAttribute("data-reply-width-room"), list: rect(list), viewport: rect(scroll), scrollTop: scroll.scrollTop,
    fromBottom: scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight, overflow: document.documentElement.scrollWidth - window.innerWidth,
    order: rows.map(node => node.dataset.messageId!),
    rows: Object.fromEntries(rows.map(node => [node.dataset.messageId!, { ...rect(node), pressed: node.querySelector(".native-run-width")?.getAttribute("aria-pressed") ?? null, card: node.querySelector(".native-run") ? rect(node.querySelector(".native-run")!) : null }])),
    // Largest overlap or gap between neighbouring mounted rows.
    seam: rows.slice(1).reduce((worst, node, i) => rows[i]!.dataset.index === String(Number(node.dataset.index) - 1) ? Math.max(worst, Math.abs(node.getBoundingClientRect().top - rows[i]!.getBoundingClientRect().bottom)) : worst, 0),
  };
});
const wheel = async (page: Page, delta: number) => {
  const box = (await page.locator(".message-scroll").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.wheel(0, delta);
};
const scrollToTop = async (page: Page) => { await expect.poll(async () => { await wheel(page, -6000); return (await layout(page)).scrollTop; }, { timeout: 15_000 }).toBeLessThanOrEqual(0); };
const scrollToBottom = async (page: Page) => { await expect.poll(async () => { await wheel(page, 6000); return (await layout(page)).fromBottom; }, { timeout: 15_000 }).toBeLessThanOrEqual(2); };

test("a desktop reply widens to its chat area alone, restores, and keeps its table behaviour", async ({ page }, info) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const f = await start(), errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  try {
    const chat = await f.chat("部署方式对比");
    const prompt = await f.ask(chat.id, "帮我对比四种静态站点的部署方式");
    await f.reply(chat.id, "table", report); await f.reply(chat.id, "wide", `指标很多的一张表，后面跟一串不能断开的字符：${"长".repeat(4)}${"x".repeat(600)}\n\n${wideTable}`); await f.reply(chat.id, "short", filler(1, 1));
    await pair(page, f.hub); await selectConversation(page, chat.title);
    await expect(toggle(page, "table")).toBeVisible();
    await expect(toggle(page, "table")).toHaveAccessibleName("加宽这条回复");
    await expect(toggle(page, "table")).toHaveAttribute("aria-pressed", "false");
    await expect(row(page, prompt.id).locator(".native-run-width")).toHaveCount(0);
    const before = await layout(page);
    expect(before.room).toBe(true); expect(before.list.width).toBeGreaterThan(856);
    for (const id of ["table", "wide", "short"]) expect(before.rows[id]!.width).toBeCloseTo(760, 0);
    // The 28px target must not make an unwidened card taller than its status line.
    expect(await row(page, "short").locator(".native-run-heading").evaluate(node => node.getBoundingClientRect().height - node.querySelector(".native-run-status")!.getBoundingClientRect().height)).toBeCloseTo(0, 0);
    const scrolls = (id: string) => row(page, id).locator(".table-scroll").evaluate(node => node.scrollWidth - node.clientWidth);
    const cellLimit = (id: string) => row(page, id).locator(".markdown-table-cell").first().evaluate(node => parseFloat(getComputedStyle(node).maxWidth) / parseFloat(getComputedStyle(node).fontSize));
    expect(await scrolls("table")).toBeGreaterThan(1);
    await expect(row(page, "table").locator(".markdown-table-tools")).toContainText("左右滑动查看");
    await page.screenshot({ path: info.outputPath("desktop-default.png"), animations: "disabled" });

    // No painted frame may show the next row left behind (a gap) or overlapped,
    // neither at the click nor when the table's tools row follows a frame later.
    const painted = () => toggle(page, "table").evaluate(async (button: HTMLButtonElement) => {
      const self = button.closest("article")!, next = document.querySelector('article[data-message-id="wide"]')!, was = self.getBoundingClientRect().height;
      const seam = () => Math.abs(next.getBoundingClientRect().top - self.getBoundingClientRect().bottom);
      button.click();
      const atClick = { seam: seam(), changed: Math.abs(self.getBoundingClientRect().height - was), width: self.getBoundingClientRect().width };
      let worst = atClick.seam;
      // Each sample is taken last among a frame's callbacks, on what that frame paints.
      for (let frame = 0; frame < 14; frame++) { await new Promise(resolve => requestAnimationFrame(resolve)); worst = Math.max(worst, seam()); await new Promise(resolve => setTimeout(resolve, 0)); }
      return { ...atClick, worst, settled: Math.abs(self.getBoundingClientRect().height - was) };
    });
    const widening = await painted();
    expect(widening.changed).toBeGreaterThan(20); expect(widening.width).toBeGreaterThan(856); expect(widening.seam).toBeLessThan(1); expect(widening.worst).toBeLessThan(1);
    // The tools row went after the click: the reply settled shorter than it was at the click.
    expect(widening.settled).toBeGreaterThan(widening.changed + 20);
    await expect(toggle(page, "table")).toHaveAttribute("aria-pressed", "true");
    await expect(toggle(page, "table")).toHaveAccessibleName("恢复阅读宽度");
    await expect(row(page, "table").locator(".markdown-table-tools")).toHaveCount(0);
    const wide = await layout(page);
    expect(wide.rows.table!.width).toBeCloseTo(wide.list.width, 0);
    expect(wide.rows.table!.right).toBeLessThanOrEqual(wide.list.right + 0.5); expect(wide.overflow).toBeLessThanOrEqual(0);
    for (const id of ["wide", "short"]) { expect(wide.rows[id]!.width).toBeCloseTo(760, 0); expect(wide.rows[id]!.pressed).toBe("false"); }
    expect(wide.rows[prompt.id]).toMatchObject({ left: before.rows[prompt.id]!.left, right: before.rows[prompt.id]!.right, width: before.rows[prompt.id]!.width });
    expect(wide.seam).toBeLessThan(1);
    // All seven columns now fit; the table's own tools retire with the overflow.
    expect(await scrolls("table")).toBeLessThanOrEqual(1);
    await expect(row(page, "table").locator(".markdown-table-tools")).toHaveCount(0);
    for (const limit of [await cellLimit("table"), await cellLimit("wide")]) { expect(limit).toBeGreaterThanOrEqual(15.9); expect(limit).toBeLessThanOrEqual(22.1); }
    // The row itself is never animated: the virtual list owns its position.
    expect(await row(page, "table").evaluate(node => ({ duration: getComputedStyle(node).transitionDuration, animation: getComputedStyle(node).animationName, transform: (node as HTMLElement).style.transform }))).toMatchObject({ duration: "0s", animation: "none", transform: expect.stringMatching(/^translateY\(/) });
    await page.screenshot({ path: info.outputPath("desktop-widened.png"), animations: "disabled" });

    // A table wider than even the widened reply keeps its local scrolling and reader.
    await toggle(page, "wide").click();
    await expect(toggle(page, "wide")).toBeFocused();
    expect(await scrolls("wide")).toBeGreaterThan(1); expect((await layout(page)).overflow).toBeLessThanOrEqual(0);
    expect(await row(page, "wide").locator(".native-run").evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    await row(page, "wide").getByRole("button", { name: "展开表格", exact: true }).click();
    const reader = page.getByRole("dialog", { name: "表格", exact: true }); await expect(reader).toBeVisible();
    await reader.getByRole("button", { name: "关闭表格", exact: true }).click(); await expect(reader).toBeHidden();
    await expect(toggle(page, "wide")).toHaveAttribute("aria-pressed", "true");

    // Restoring grows the reply twice (text, then the table's tools row), again without a bad frame.
    const restoring = await painted();
    expect(restoring.changed).toBeGreaterThan(20); expect(restoring.settled).toBeGreaterThan(restoring.changed + 20); expect(restoring.worst).toBeLessThan(1);
    await expect(toggle(page, "table")).toHaveAttribute("aria-pressed", "false");
    await toggle(page, "table").click(); await expect(toggle(page, "table")).toHaveAttribute("aria-pressed", "true");
    // Keyboard: the same control restores, and keeps focus as it moves back.
    await toggle(page, "table").focus(); await page.keyboard.press("Space");
    await expect(toggle(page, "table")).toHaveAttribute("aria-pressed", "false");
    await expect(toggle(page, "table")).toBeFocused();
    await page.keyboard.press("Enter"); await expect(toggle(page, "table")).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Enter"); await expect(toggle(page, "table")).toBeFocused();
    // Settled means the table's tools row is back, not merely that time has passed.
    await expect(row(page, "table").locator(".markdown-table-tools")).toContainText("左右滑动查看");
    await expect.poll(async () => { const now = await layout(page); return [Math.round(now.rows.table!.width), Math.round(now.rows.table!.height), now.rows.wide!.pressed, now.seam < 1]; }).toEqual([760, Math.round(before.rows.table!.height), "true", true]);
    expect(await scrolls("table")).toBeGreaterThan(1);
    expect(errors).toEqual([]);
  } finally { await page.close(); await f.close(); }
});

test("a widened reply survives virtualization and conversation switches, and stays in its own conversation", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const f = await start();
  try {
    const long = await f.chat("长对话"), other = await f.chat("另一个对话");
    for (let i = 1; i <= 36; i++) await f.reply(long.id, `long-${i}`, filler(i));
    for (let i = 1; i <= 3; i++) await f.reply(other.id, `other-${i}`, filler(i));
    await pair(page, f.hub); await selectConversation(page, long.title);
    await expect(row(page, "long-36")).toBeVisible(); await expect(row(page, "long-2")).toHaveCount(0);
    await scrollToTop(page); await expect(toggle(page, "long-2")).toBeVisible();
    await toggle(page, "long-2").click();
    const listWidth = (await layout(page)).list.width;
    const expectOnlySecondWide = async () => { await expect.poll(async () => { const now = await layout(page); return [Math.round(now.rows["long-2"]?.width ?? 0), now.rows["long-2"]?.pressed, Math.round(now.rows["long-1"]?.width ?? 0), Math.round(now.rows["long-3"]?.width ?? 0), now.seam < 1]; }).toEqual([Math.round(listWidth), "true", 760, 760, true]); };
    await expectOnlySecondWide();
    // Focus keeps a row mounted; leave it, then scroll the row out of the list.
    await page.getByRole("textbox", { name: "消息", exact: true }).focus();
    await scrollToBottom(page); await expect(row(page, "long-2")).toHaveCount(0);
    await scrollToTop(page); await expectOnlySecondWide();

    await selectConversation(page, other.title);
    await expect(toggle(page, "other-3")).toBeVisible();
    const elsewhere = await layout(page);
    for (const id of ["other-1", "other-2", "other-3"]) { expect(elsewhere.rows[id]!.pressed).toBe("false"); expect(elsewhere.rows[id]!.width).toBeCloseTo(760, 0); }
    await toggle(page, "other-1").click(); await expect(toggle(page, "other-1")).toHaveAttribute("aria-pressed", "true");
    await toggle(page, "other-1").click(); await expect(toggle(page, "other-1")).toHaveAttribute("aria-pressed", "false");

    await selectConversation(page, long.title);
    await expect(row(page, "long-36")).toBeVisible();
    await scrollToTop(page); await expectOnlySecondWide();
    // View state only: a reload starts every reply at the reading width again.
    await page.reload(); await waitForClientOnline(page); await selectConversation(page, long.title);
    await expect(row(page, "long-36")).toBeVisible(); await scrollToTop(page);
    await expect(toggle(page, "long-2")).toHaveAttribute("aria-pressed", "false");
    expect((await layout(page)).rows["long-2"]!.width).toBeCloseTo(760, 0);
  } finally { await page.close(); await f.close(); }
});

test("widening stops at the chat area, withdraws when the area is narrow and returns with it", async ({ page }, info) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const f = await start();
  try {
    const chat = await f.chat("窗口与面板");
    await f.reply(chat.id, "table", report); await f.reply(chat.id, "short", filler(1, 1));
    await pair(page, f.hub); await selectConversation(page, chat.title);
    await toggle(page, "table").click();
    await expect.poll(async () => (await layout(page)).rows.table!.width).toBeGreaterThan(1000);
    // No room beyond the reading width: neither a control nor a widened row.
    await page.setViewportSize({ width: 1040, height: 1000 });
    await expect(toggle(page, "table")).toBeHidden(); await expect(toggle(page, "short")).toBeHidden();
    await expect.poll(async () => { const now = await layout(page); return [now.room, now.list.width < 856, Math.round(now.rows.table!.width) === Math.round(now.rows.short!.width), now.rows.table!.right <= now.list.right + 0.5, now.overflow <= 0, now.seam < 1]; }).toEqual([false, true, true, true, true, true]);
    await page.screenshot({ path: info.outputPath("desktop-narrow-window.png"), animations: "disabled" });
    // The choice was kept; it applies again as soon as the area has room.
    await page.setViewportSize({ width: 1600, height: 1000 });
    await expect(toggle(page, "table")).toBeVisible(); await expect(toggle(page, "table")).toHaveAttribute("aria-pressed", "true");
    await expect.poll(async () => { const now = await layout(page); return [now.room, Math.round(now.rows.table!.width) === Math.round(now.list.width), Math.round(now.rows.short!.width), now.seam < 1]; }).toEqual([true, true, 760, true]);

    // A side panel takes its space from the chat area; the reply ends there too.
    await page.getByRole("button", { name: "工作台", exact: true }).click();
    const panel = page.locator(".conversation-side-panel").first(); await expect(panel).toBeVisible();
    // The loading fallback can be replaced between visibility and measurement.
    // A missing box is not success: keep polling until the real panel is visible
    // and all of the original layout assertions hold together.
    await expect.poll(async () => { const box = await panel.boundingBox(); if (!box) return [false, false, false, false]; const now = await layout(page), edge = box.x; return [now.rows.table!.right <= Math.min(now.list.right, edge) + 0.5, now.overflow <= 0, now.seam < 1, now.room ? Math.round(now.rows.table!.width) === Math.round(now.list.width) : Math.round(now.rows.table!.width) === Math.round(now.rows.short!.width)]; }).toEqual([true, true, true, true]);
    await page.screenshot({ path: info.outputPath("desktop-side-panel.png"), animations: "disabled" });
  } finally { await page.close(); await f.close(); }
});

test("toggling keeps the reader's place in history and at the tail, through a streaming reply", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  const f = await start();
  try {
    const chat = await f.chat("滚动与流式");
    for (let i = 1; i <= 18; i++) await f.reply(chat.id, `past-${i}`, filler(i, 4));
    await f.reply(chat.id, "live", "正在整理第一部分。", { phase: "working" });
    await pair(page, f.hub); await selectConversation(page, chat.title);
    await expect(row(page, "live").locator(".native-run-status .spin")).toBeVisible();
    await expect.poll(async () => (await layout(page)).fromBottom).toBeLessThanOrEqual(2);

    // Reading history: the toggled reply keeps its top edge; nothing jumps to the latest message.
    await wheel(page, -2600);
    const latest = page.getByRole("button", { name: "回到最新消息", exact: true }); await expect(latest).toBeVisible();
    // A reply whose heading, and so its control, is on screen with rows below it.
    const target = await page.evaluate(() => { const view = document.querySelector(".message-scroll")!.getBoundingClientRect(); return [...document.querySelectorAll<HTMLElement>("article[data-message-id]")].find(node => { const top = node.getBoundingClientRect().top; return top > view.top + 20 && top < view.top + view.height / 2; })!.dataset.messageId!; });
    for (const pressed of ["true", "false"]) {
      const was = await layout(page);
      await toggle(page, target).click(); await expect(toggle(page, target)).toHaveAttribute("aria-pressed", pressed);
      await expect.poll(async () => { const now = await layout(page); return [Math.abs(now.rows[target]!.top - was.rows[target]!.top) <= 1, Math.abs(now.scrollTop - was.scrollTop) <= 1, now.fromBottom > 200, now.seam < 1, Math.abs(now.rows[target]!.height - was.rows[target]!.height) > 20]; }).toEqual([true, true, true, true, true]);
      await expect(latest).toBeVisible(); await expect(toggle(page, target)).toBeInViewport();
    }

    // Following the latest message: a streaming reply can be widened and stays followed.
    await latest.click(); await expect.poll(async () => (await layout(page)).fromBottom).toBeLessThanOrEqual(2);
    await toggle(page, "live").click(); await expect(toggle(page, "live")).toHaveAttribute("aria-pressed", "true");
    for (let revision = 2; revision <= 4; revision++) {
      await f.reply(chat.id, "live", Array.from({ length: revision * 2 }, (_, i) => filler(i + 1, 1)).join("\n\n"), { phase: "working", revision });
      await expect(row(page, "live").locator(".native-run-prose")).toContainText(`第 ${revision * 2} 条记录`);
      await expect.poll(async () => { const now = await layout(page); return [now.fromBottom <= 2, now.rows.live!.pressed, Math.round(now.rows.live!.width) === Math.round(now.list.width), now.seam < 1]; }).toEqual([true, "true", true, true]);
    }
    await f.reply(chat.id, "live", `${filler(1, 2)}\n\n${table}`, { revision: 5 });
    await expect(row(page, "live").locator(".native-run-status")).toContainText("已完成");
    await expect.poll(async () => { const now = await layout(page); return [now.fromBottom <= 2, now.rows.live!.pressed, Math.round(now.rows.live!.width) === Math.round(now.list.width)]; }).toEqual([true, "true", true]);
    // Restoring it at the tail stays at the tail, with the control still on screen.
    await toggle(page, "live").click(); await expect(toggle(page, "live")).toHaveAttribute("aria-pressed", "false");
    await expect.poll(async () => { const now = await layout(page); return [now.fromBottom <= 2, Math.round(now.rows.live!.width), now.seam < 1]; }).toEqual([true, 760, true]);
    await expect(toggle(page, "live")).toBeInViewport(); await expect(latest).toBeHidden();
    // A new reply starts at the reading width, whatever the one before it did.
    await toggle(page, "live").click(); await f.reply(chat.id, "fresh", filler(99, 2));
    await expect(toggle(page, "fresh")).toHaveAttribute("aria-pressed", "false");
    await expect.poll(async () => { const now = await layout(page); return [now.fromBottom <= 2, Math.round(now.rows.fresh!.width), now.rows.live!.pressed]; }).toEqual([true, 760, "true"]);
  } finally { await page.close(); await f.close(); }
});

test("the control is offered only for main replies in the desktop main chat", async ({ page }) => {
  const f = await start();
  // One paired page plays every device: the choice survives a reload in window.name.
  await page.addInitScript(() => {
    const device = JSON.parse(window.name || "null") as { userAgent?: string; platform?: string; maxTouchPoints?: number } | null;
    for (const [name, value] of Object.entries(device ?? {})) Object.defineProperty(Navigator.prototype, name, { configurable: true, get: () => value });
  });
  try {
    const chat = await f.chat("范围检查");
    await f.reply(chat.id, "main", filler(1)); await f.reply(chat.id, "task", filler(2, 1), { scoped: true });
    await page.setViewportSize({ width: 1600, height: 1000 }); await pair(page, f.hub); await selectConversation(page, chat.title);
    // Desktop: the main reply has it; a subagent / background card never does.
    await expect(toggle(page, "main")).toBeVisible();
    await expect(page.locator(".message-scroll").getByText("第 2 条记录").first()).toBeVisible();
    await expect(page.locator(".native-run-width")).toHaveCount(1);
    await toggle(page, "main").click(); await expect.poll(async () => (await layout(page)).rows.main!.width).toBeGreaterThan(856);

    // The phone layout, and touch platforms whose window is as wide as a desktop's.
    const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
    for (const device of [
      { name: "phone layout", viewport: { width: 390, height: 844 }, navigator: null },
      { name: "iPad", viewport: { width: 1366, height: 1024 }, navigator: { userAgent: "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1", platform: "iPad", maxTouchPoints: 5 } },
      { name: "iPad desktop-class browser", viewport: { width: 1366, height: 1024 }, navigator: { userAgent: mac, platform: "MacIntel", maxTouchPoints: 5 } },
      { name: "Android tablet", viewport: { width: 1600, height: 1000 }, navigator: { userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel Tablet) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36", platform: "Linux armv81", maxTouchPoints: 5 } },
    ]) await test.step(device.name, async () => {
      await page.evaluate(value => { window.name = JSON.stringify(value); }, device.navigator);
      await page.setViewportSize(device.viewport); await page.reload(); await waitForClientOnline(page); await selectConversation(page, chat.title);
      if (device.navigator) expect(await page.evaluate(() => navigator.userAgent)).toBe(device.navigator.userAgent);
      await expect(row(page, "main").locator(".native-run")).toBeVisible();
      await expect(page.locator(".native-run-width")).toHaveCount(0);
      expect(await page.locator(".message-scroll").evaluate(node => node.hasAttribute("data-reply-width-room"))).toBe(false);
      expect(await row(page, "main").evaluate(node => node.getBoundingClientRect().width)).toBeLessThanOrEqual(760.5);
    });

    // Back on an ordinary desktop the control returns.
    await page.evaluate(() => { window.name = ""; }); await page.setViewportSize({ width: 1600, height: 1000 });
    await page.reload(); await waitForClientOnline(page); await selectConversation(page, chat.title);
    await expect(toggle(page, "main")).toBeVisible(); await expect(page.locator(".native-run-width")).toHaveCount(1);
    // The ADHD board renders the same replies in panes, at any width.
    await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
    await page.getByRole("checkbox", { name: `加入面板：演示主机 · ${chat.title}`, exact: true }).check();
    await expect(page.locator(".adhd-card .native-run").first()).toBeVisible();
    await expect(page.locator(".adhd-card .native-run-width")).toHaveCount(0);
    expect(await page.locator(".adhd-card .message-scroll").evaluateAll(nodes => nodes.filter(node => node.hasAttribute("data-reply-width-room")).length)).toBe(0);
  } finally { await page.close(); await f.close(); }
});

test("the control reads in English and keeps its place in dark and CLI appearances", async ({ page }, info) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const f = await start();
  try {
    const chat = await f.chat("外观与语言");
    await f.reply(chat.id, "table", report); await f.reply(chat.id, "live", "Checking the second source.", { phase: "working" });
    await pair(page, f.hub); await selectConversation(page, chat.title);
    await openSettings(page); await page.locator("#theme").selectOption("dark"); await page.locator("#language").selectOption("en"); await closeSettings(page, true);
    await expect(toggle(page, "table")).toHaveAccessibleName("Widen reply");
    await expect(toggle(page, "table")).toHaveAttribute("title", "Widen reply");
    const heading = (id: string) => row(page, id).locator(".native-run-heading").evaluate(node => {
      const rect = (target: Element) => target.getBoundingClientRect(), card = rect(node.closest(".native-run")!), button = rect(node.querySelector(".native-run-width")!), time = rect(node.querySelector("time")!), label = node.querySelector<HTMLElement>(".native-run-status > span:not(.run-state-dot)")!;
      return { inside: button.left >= card.left && button.right <= card.right + 0.5, afterTime: button.left - time.right, height: rect(node).height, labelClipped: label.scrollWidth > label.clientWidth, background: getComputedStyle(node.querySelector(".native-run-width")!).backgroundColor };
    });
    for (const id of ["table", "live"]) expect(await heading(id)).toMatchObject({ inside: true, labelClipped: false, background: "rgba(0, 0, 0, 0)" });
    expect((await heading("table")).afterTime).toBeGreaterThanOrEqual(2);
    await toggle(page, "table").click();
    await expect(toggle(page, "table")).toHaveAccessibleName("Restore width");
    const pressed = await heading("table");
    expect(pressed.inside).toBe(true); expect(pressed.afterTime).toBeGreaterThanOrEqual(2); expect(pressed.background).not.toBe("rgba(0, 0, 0, 0)");
    await page.screenshot({ path: info.outputPath("desktop-dark-english.png"), animations: "disabled" });
    for (const appearance of [{ palette: "mono", theme: "light" }, { palette: "cli", theme: "dark" }, { palette: "white-blue", theme: "light" }]) {
      await page.evaluate(({ palette, theme }) => { document.documentElement.dataset.palette = palette; document.documentElement.dataset.theme = theme; }, appearance);
      await expect.poll(async () => { const now = await heading("table"), geometry = await layout(page); return [now.inside, now.afterTime >= 2, now.background !== "rgba(0, 0, 0, 0)", Math.round(geometry.rows.table!.width) === Math.round(geometry.list.width), geometry.seam < 1]; }).toEqual([true, true, true, true, true]);
      await page.screenshot({ path: info.outputPath(`desktop-${appearance.palette}-${appearance.theme}.png`), animations: "disabled" });
    }
  } finally { await page.close(); await f.close(); }
});
