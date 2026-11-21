import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import type { RunSummary } from "../../src/client-protocol/run.js";
import { mobileHome, showDisconnectedBots, selectConversation, waitForClientOnline } from "./fixtures/mobile.js";
import { openSettings, closeSettings } from "./fixtures/settings.js";

// Message timestamps add the day once a message is older than today. The
// longer text must stay on one line beside the author, reply status and the
// desktop action row. Wording rules are unit-tested in tests/client-message-time.test.ts.
const run = (id: string, phase: RunSummary["phase"]): RunSummary => ({ id, phase, revision: 1, version: 1, startedAt: Date.now() - 1000, updatedAt: Date.now(), count: 0, completed: 0, failed: 0, truncated: false });
const two = (value: number) => String(value).padStart(2, "0");
const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** Independent statement of the display rule for whatever day the suite runs. */
function expected(at: number, now: number, english: boolean, compact = false): string {
  const date = new Date(at), today = new Date(now), time = `${two(date.getHours())}:${two(date.getMinutes())}`;
  const start = (daysAgo: number) => new Date(today.getFullYear(), today.getMonth(), today.getDate() - daysAgo).getTime();
  if (at >= start(0)) return time;
  const year = date.getFullYear(), month = date.getMonth(), day = date.getDate();
  if (!compact && at >= start(1)) return `${english ? "Yesterday" : "昨天"} ${time}`;
  if (compact) return year === today.getFullYear() ? `${month + 1}/${day} ${time}` : english ? `${month + 1}/${day}/${year}` : `${year}/${month + 1}/${day}`;
  if (year === today.getFullYear()) return english ? `${months[month]} ${day} ${time}` : `${month + 1}月${day}日 ${time}`;
  return english ? `${months[month]} ${day}, ${year} ${time}` : `${year}年${month + 1}月${day}日 ${time}`;
}

type Row = { id: string; text: string; lines: number; metaOverflow: boolean; metaHeight: number; inside: boolean; overlap: boolean; user: boolean };
/** One geometry sample per rendered message row. */
const chatRows = ".host-workspace:not([hidden]) .message-scroll article.message";
const measure = (page: Page, rows = chatRows) => page.locator(rows).evaluateAll(nodes => nodes.flatMap(node => {
  const meta = node.querySelector<HTMLElement>(".message-meta"), time = meta?.querySelector<HTMLElement>(":scope > time");
  if (!meta || !time) return [];
  const range = document.createRange(); range.selectNodeContents(time);
  const tops = new Set([...range.getClientRects()].filter(rect => rect.width > 0).map(rect => Math.round(rect.top)));
  const box = meta.getBoundingClientRect(), own = time.getBoundingClientRect();
  const siblings = [...meta.children].filter(child => child !== time).map(child => child.getBoundingClientRect()).filter(rect => rect.width > 1 && rect.height > 1);
  return [{
    id: node.getAttribute("data-message-id") ?? "", text: time.textContent ?? "", lines: tops.size, user: node.classList.contains("user"),
    metaOverflow: meta.scrollWidth > meta.clientWidth + 1, metaHeight: Math.round(box.height),
    inside: own.left >= box.left - 1 && own.right <= box.right + 1 && own.left >= 0 && own.right <= document.documentElement.clientWidth,
    overlap: siblings.some(rect => rect.left < own.right - 1 && rect.right > own.left + 1 && rect.top < own.bottom - 1 && rect.bottom > own.top + 1),
  }];
}) as Row[]);

/** "saved" is whatever the App applied itself; the CLI palette brackets the time and never hides it. */
const setPalette = (page: Page, palette: string) => page.evaluate(palette => {
  const root = document.documentElement; root.dataset.savedPalette ??= root.dataset.palette ?? "";
  if (palette === "cli") root.dataset.palette = palette; else if (root.dataset.savedPalette) root.dataset.palette = root.dataset.savedPalette; else delete root.dataset.palette;
}, palette);
async function checkRows(page: Page, selector: string, label: string, text: (id: string) => string) {
  const rows = await measure(page, selector);
  expect(rows.length, label).toBeGreaterThan(0);
  for (const row of rows) {
    expect(row.text, label).toBe(text(row.id));
    expect(row, `${label} ${row.text}`).toMatchObject({ lines: 1, metaOverflow: false, inside: true, overlap: false });
  }
  // A dated row is exactly as tall as today's time-only row of the same side.
  for (const user of [true, false]) expect(new Set(rows.filter(row => row.user === user).map(row => row.metaHeight)).size, label).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), label).toBe(true);
}

/** "Today" must not turn into "yesterday" halfway through: start after an imminent real midnight. */
async function clearOfMidnight() {
  const beforeMidnight = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate() + 1).getTime() - Date.now();
  if (beforeMidnight < 90_000) await new Promise(resolve => setTimeout(resolve, beforeMidnight + 1000));
}

for (const touch of [true, false]) test(`message timestamps add the day for older messages and stay on one line (${touch ? "touch phone" : "desktop pointer"})`, async ({ browser }, info) => {
  test.setTimeout(240_000);
  await clearOfMidnight();
  // Touch devices always show the sender's own time; a hover pointer reveals it with the action row.
  const context = await browser.newContext({ viewport: { width: 1360, height: 1900 }, locale: "zh-CN", serviceWorkers: "block", ...(touch ? { isMobile: true, hasTouch: true } : {}) });
  const page = await context.newPage();
  const root = await mkdtemp(path.join(os.tmpdir(), "message-time-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  try {
    await hub.profile.update({ name: "示例主机", revision: (await hub.profile.read()).revision });
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,online) VALUES('alpha','跨团队研究与设计协作长名称助手 Research and Design Assistant','fixture-a',1),('beta','CC1','fixture-b',1),('gamma','Kimi','fixture-c',1)");
    const chat = await hub.store.createConversation("owner", ["alpha", "beta", "gamma"], "消息时间", "message-time", { type: "group" });
    // Six board panes make each one as narrow as the board allows.
    const others = await Promise.all([0, 1, 2, 3, 4].map(index => hub.store.createConversation("owner", ["beta"], `其他对话 ${index}`, `other-${index}`)));
    const now = Date.now(), today = new Date(now);
    const at = (daysAgo: number, hour: number, minute: number) => new Date(today.getFullYear(), today.getMonth(), today.getDate() - daysAgo, hour, minute).getTime();
    // Oldest first: another year, earlier in the year, yesterday, today.
    const days = [["old", at(400, 14, 5)], ["earlier", at(40, 9, 7)], ["yesterday", at(1, 23, 59)], ["today", now]] as const;
    const times = new Map<string, number>();
    for (const [name, sentAt] of days) {
      const prompt = (await hub.store.sendMessage("owner", { conversationId: chat.id, clientMsgId: `ask-${name}`, text: `请核对方案（${name}）`, attachments: [] })).message;
      times.set(prompt.id, sentAt);
      // The oldest prompt carries the widest reply status next to the longest date.
      const replies = name === "old" ? [["alpha", "done"], ["beta", "working"], ["gamma", "error"]] as const : [["alpha", "done"]] as const;
      for (const [index, [bot, phase]] of replies.entries()) {
        const reply = await hub.store.publishBotMessage(bot, { conversationId: chat.id, replyTo: prompt.id, blocks: [{ type: "card", elements: [{ type: "markdown", text: `已核对（${name}）` }], extra: { nativeRun: run(`${name}-${bot}`, phase) } }] });
        times.set(reply.id, sentAt + index + 1);
      }
    }
    // Snapshot and replay both carry the time, so backdate the row and its events.
    for (const [id, sentAt] of times) {
      await hub.store.db.run("UPDATE messages SET created_at=? WHERE id=?", [sentAt, id]);
      await hub.store.db.run("UPDATE events SET payload_json=json_set(payload_json,'$.createdAt',?) WHERE conversation_id=? AND json_extract(payload_json,'$.id')=? AND kind LIKE 'message.%'", [sentAt, chat.id, id]);
    }

    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await showDisconnectedBots(page);
    await waitForClientOnline(page); await selectConversation(page, chat.title);

    for (const english of [false, true]) {
      if (english) {
        await page.setViewportSize({ width: 1360, height: 1900 });
        await openSettings(page); await page.getByLabel("语言", { exact: true }).selectOption("en"); await closeSettings(page, true);
      }
      // Phones and roomy desktop windows spell the day out. A small desktop
      // window also reserves the hover actions in the same row, so it is compact.
      for (const width of touch ? [320, 390] : [780, 1360]) for (const palette of ["saved", "cli"]) {
        await page.setViewportSize({ width, height: 1900 });
        await setPalette(page, palette);
        await expect.poll(async () => (await measure(page)).length).toBe(times.size);
        // Park the pointer away from the rows so no hover state is captured.
        await page.mouse.move(width - 2, 2);
        const label = `${english ? "en" : "zh"} ${width} ${palette}`;
        if (palette === "saved") await page.screenshot({ path: info.outputPath(`message-time-${english ? "en" : "zh"}-${width}.png`), animations: "disabled" });
        const check = () => checkRows(page, chatRows, label, id => expected(times.get(id)!, now, english, width === 780));
        await check();
        if (!touch) for (const id of times.keys()) {
          // The desktop action row appears beside the timestamp on hover.
          const row = page.locator(`${chatRows}[data-message-id="${id}"]`);
          await row.locator(".message-meta").hover(); await expect(row.locator(".message-actions")).toBeVisible();
          await check();
        }
      }
      if (touch) continue;
      // Board panes are the narrowest message columns and always reserve the actions.
      await setPalette(page, "saved"); await page.setViewportSize({ width: 1360, height: 1900 });
      await page.getByRole("button", { name: english ? "Open ADHD mode" : "打开 ADHD 模式", exact: true }).click();
      for (const title of [chat.title, ...others.map(other => other.title)]) await page.getByRole("checkbox", { name: english ? `Add to board: 示例主机 · ${title}` : `加入面板：示例主机 · ${title}`, exact: true }).check();
      await page.getByLabel(english ? "ADHD columns per row" : "ADHD 每行窗口数", { exact: true }).selectOption("6");
      const cardRows = `.adhd-card[data-pane-conversation="${chat.id}"] article.message`, label = `${english ? "en" : "zh"} board pane`;
      await expect.poll(async () => (await measure(page, cardRows)).length).toBe(times.size);
      const check = () => checkRows(page, cardRows, label, id => expected(times.get(id)!, now, english, true));
      await page.mouse.move(1358, 2); await check();
      await page.screenshot({ path: info.outputPath(`message-time-${english ? "en" : "zh"}-board.png`), animations: "disabled" });
      for (const id of times.keys()) {
        const row = page.locator(`${cardRows}[data-message-id="${id}"]`);
        await row.scrollIntoViewIfNeeded(); await row.locator(".message-meta").hover(); await expect(row.locator(".message-actions")).toBeVisible();
        await check();
      }
      await page.getByRole("button", { name: english ? "Back to chat" : "返回聊天", exact: true }).click();
      if (!english) { await selectConversation(page, chat.title); await expect.poll(async () => (await measure(page)).length).toBe(times.size); }
    }
  } finally { await context.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

const nextMidnight = async (page: Page) => { const date = new Date(await page.evaluate(() => Date.now())); return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime(); };
/** The native App's return-to-foreground signal. Nothing but the shared day source listens to it. */
const resumeApp = (page: Page) => page.evaluate(() => { document.dispatchEvent(new Event("resume")); });
/**
 * Sets the page's clock a few seconds before its next local midnight and lets it run on.
 * Nothing else is touched afterwards, so only the App's own midnight timer can change a label.
 * Returns that midnight.
 */
async function approachMidnight(page: Page): Promise<number> {
  const midnight = await nextMidnight(page);
  await page.clock.setSystemTime(midnight - 4000);
  await resumeApp(page);
  return midnight;
}
/**
 * Holds every page timer still, moves the clock past the next local midnight and signals the
 * return, as after a night in the background: only the comparison on return can notice the
 * new day. The caller resumes the clock. Returns that midnight.
 */
async function returnAfterMidnight(page: Page): Promise<number> {
  const midnight = await nextMidnight(page);
  await page.clock.pauseAt(await page.evaluate(() => Date.now()) + 1000);
  await page.clock.setSystemTime(midnight + 5000);
  await resumeApp(page);
  return midnight;
}
const clockOnly = /^\d{2}:\d{2}$/;

// The App stays open across midnight: wording that is relative to today must follow the local
// day by itself, in the message list, a board pane, both conversation lists and the phone sheet.
// Reads between a clock change and its assertion are passive, so no click, hover or resize can
// stand in for the refresh.
for (const touch of [true, false]) for (const english of [false, true]) test(`relative dates follow the local day while the App stays open (${touch ? "touch phone" : "desktop pointer"}, ${english ? "en" : "zh"})`, async ({ browser }, info) => {
  test.setTimeout(180_000);
  await clearOfMidnight();
  const context = await browser.newContext({ viewport: { width: 1360, height: 1900 }, locale: "zh-CN", serviceWorkers: "block", ...(touch ? { isMobile: true, hasTouch: true } : {}) });
  const page = await context.newPage();
  // The page's clock starts at the real time and keeps running until the test moves it.
  await page.clock.install();
  const root = await mkdtemp(path.join(os.tmpdir(), "message-day-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  try {
    await hub.profile.update({ name: "示例主机", revision: (await hub.profile.read()).revision });
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,online) VALUES('beta','CC1','fixture-b',1)");
    const chat = await hub.store.createConversation("owner", ["beta"], "消息时间", "message-day");
    const other = await hub.store.createConversation("owner", ["beta"], "其他对话", "message-day-other");
    const today = new Date();
    const on = (days: number) => new Date(today.getFullYear(), today.getMonth(), today.getDate() + days, today.getHours(), today.getMinutes(), today.getSeconds()).getTime();
    // Yesterday, today and tomorrow. The Hub keeps the real time, so the message that "arrives"
    // after the first midnight is stamped ahead: it is today's once the page is a day on.
    const times = new Map<string, number>(), prompts = new Map<number, string>();
    for (const days of [-1, 0, 1]) {
      const prompt = (await hub.store.sendMessage("owner", { conversationId: chat.id, clientMsgId: `ask-${days}`, text: `请核对方案（${days}）`, attachments: [] })).message;
      const reply = await hub.store.publishBotMessage("beta", { conversationId: chat.id, replyTo: prompt.id, blocks: [{ type: "card", elements: [{ type: "markdown", text: `已核对（${days}）` }], extra: { nativeRun: run(`day-${days}`, "done") } }] });
      times.set(prompt.id, on(days)); times.set(reply.id, on(days) + 1); prompts.set(days, prompt.id);
    }
    for (const [id, sentAt] of times) {
      await hub.store.db.run("UPDATE messages SET created_at=? WHERE id=?", [sentAt, id]);
      await hub.store.db.run("UPDATE events SET payload_json=json_set(payload_json,'$.createdAt',?) WHERE conversation_id=? AND json_extract(payload_json,'$.id')=? AND kind LIKE 'message.%'", [sentAt, chat.id, id]);
    }
    // The other conversation's latest activity is today, so its list row turns at the first midnight.
    await hub.store.sendMessage("owner", { conversationId: other.id, clientMsgId: "ask-other", text: "今天的另一条消息", attachments: [] });

    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await showDisconnectedBots(page);
    await waitForClientOnline(page); await selectConversation(page, chat.title);
    if (english) { await openSettings(page); await page.getByLabel("语言", { exact: true }).selectOption("en"); await closeSettings(page, true); }
    const text = (zh: string, en: string) => english ? en : zh;
    const yesterday = text("昨天", "Yesterday"), name = `${touch ? "phone" : "desktop"} ${english ? "en" : "zh"}`;
    /** What the timestamp of the prompt sent `days` from today reads on the day of `at`. */
    const stamp = (days: number, at: number, compact = false) => expected(times.get(prompts.get(days)!)!, at, english, compact);
    const wanted = (at: number, compact: boolean) => Object.fromEntries([...times].map(([id, sentAt]) => [id, expected(sentAt, at, english, compact)]));
    /** Passive read: waits until every timestamp reads as it should on the day of `at`. */
    const reads = (at: number, label: string, selector = chatRows, compact = false) =>
      expect.poll(async () => Object.fromEntries((await measure(page, selector)).map(row => [row.id, row.text])), { message: label, timeout: 15_000 }).toEqual(wanted(at, compact));
    /** The same wording, plus the one-line layout of every row. */
    const holds = async (at: number, label: string, selector = chatRows, compact = false) => {
      await reads(at, label, selector, compact);
      if (!touch) await page.mouse.move(1358, 2);
      await checkRows(page, selector, label, id => wanted(at, compact)[id]!);
    };

    if (touch) {
      await page.setViewportSize({ width: 390, height: 1900 });
      const listTime = (title: string) => mobileHome(page).locator(".mh-row").filter({ has: page.getByText(title, { exact: true }) }).locator(".mh-row-time");
      const day0 = await page.evaluate(() => Date.now()), clock = stamp(0, day0);
      expect(clock).toMatch(clockOnly);
      await holds(day0, `${name} before midnight`);
      // The long-press sheet repeats the timestamp. It stays open across the first midnight.
      const prompt = page.locator(`${chatRows}[data-message-id="${prompts.get(0)}"]`);
      const author = await prompt.locator(".message-meta > strong").innerText();
      await prompt.focus(); await page.keyboard.press("Enter");
      const sheetLine = page.getByRole("dialog", { name: text("消息操作", "Message actions"), exact: true }).locator(".message-sheet-preview > small");
      await expect(sheetLine).toHaveText(`${author} · ${clock}`);
      const day1 = await approachMidnight(page);
      expect(stamp(0, day1)).toBe(`${yesterday} ${clock}`);
      await reads(day1, `${name} after midnight`);
      await expect(sheetLine).toHaveText(`${author} · ${yesterday} ${clock}`);
      await page.getByRole("button", { name: text("关闭消息操作", "Close message actions"), exact: true }).click();
      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 1900 });
        await holds(day1, `${name} ${width} after midnight`);
        await page.screenshot({ path: info.outputPath(`message-day-${english ? "en" : "zh"}-${width}.png`), animations: "disabled" });
      }
      // The phone's conversation list: tomorrow's message is today's now; the other chat was last active yesterday.
      await page.getByRole("button", { name: text("打开会话列表", "Open conversation list"), exact: true }).click();
      await expect(listTime(chat.title)).toHaveText(clockOnly); await expect(listTime(other.title)).toHaveText(yesterday);
      await returnAfterMidnight(page);
      await expect(listTime(chat.title)).toHaveText(yesterday);
      await page.clock.resume();
      return;
    }

    // The desktop conversation list shows row times in its per-conversation layout.
    const sidebar = page.locator(".host-workspace:not([hidden]) .sidebar");
    await sidebar.getByRole("button", { name: text("按对话", "Chats"), exact: true }).click();
    const listTime = (title: string) => sidebar.locator(".conversation-row").filter({ has: page.getByText(title, { exact: true }) }).locator(".inbox-row-meta time");
    const day0 = await page.evaluate(() => Date.now()), clock = stamp(0, day0);
    expect(clock).toMatch(clockOnly);
    await holds(day0, `${name} before midnight`);
    await expect(listTime(chat.title)).toHaveText(clockOnly); await expect(listTime(other.title)).toHaveText(clockOnly);
    const day1 = await approachMidnight(page);
    expect(stamp(0, day1)).toBe(`${yesterday} ${clock}`);
    await reads(day1, `${name} after midnight`);
    await expect(listTime(other.title)).toHaveText(yesterday); await expect(listTime(chat.title)).toHaveText(clockOnly);
    await holds(day1, `${name} after midnight`);
    await page.screenshot({ path: info.outputPath(`message-day-${english ? "en" : "zh"}-1360.png`), animations: "disabled" });
    // A board pane uses the compact form: today's clock gains its numeric day at the next midnight.
    await page.getByRole("button", { name: text("打开 ADHD 模式", "Open ADHD mode"), exact: true }).click();
    await page.getByRole("checkbox", { name: text(`加入面板：示例主机 · ${chat.title}`, `Add to board: 示例主机 · ${chat.title}`), exact: true }).check();
    const paneRows = `.adhd-card[data-pane-conversation="${chat.id}"] article.message`;
    // The board's own conversation list is not rendered by any conversation view.
    const boardTime = (title: string) => page.locator(".adhd-shell .sidebar .conversation-row").filter({ has: page.getByText(title, { exact: true }) }).locator(".inbox-row-meta time");
    expect(stamp(1, day1, true)).toMatch(clockOnly);
    await holds(day1, `${name} board pane before the next midnight`, paneRows, true);
    await expect(boardTime(chat.title)).toHaveText(clockOnly);
    const day2 = await returnAfterMidnight(page);
    expect(stamp(1, day2, true)).not.toMatch(clockOnly);
    await reads(day2, `${name} board pane after the next midnight`, paneRows, true);
    await expect(boardTime(chat.title)).toHaveText(yesterday);
    await page.clock.resume();
    await holds(day2, `${name} board pane after the next midnight`, paneRows, true);
    await page.screenshot({ path: info.outputPath(`message-day-${english ? "en" : "zh"}-board.png`), animations: "disabled" });
  } finally { await context.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
