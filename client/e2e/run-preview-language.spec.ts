import { test, expect } from "@playwright/test";
import { createServer } from "./fixtures/vite.js";
import type { ViteDevServer } from "vite";
import type { ClientCache } from "../src/storage.js";
import type { Message } from "../../src/client-protocol/index.js";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { preparePairing } from "./fixtures/pairing-invite.js";
import { showDisconnectedBots, mobileHome } from "./fixtures/mobile.js";
import { openSettings, closeSettings } from "./fixtures/settings.js";

let server: ViteDevServer, url: string;
test.beforeAll(async () => {
  server = await createServer({ server: { port: 0, host: "127.0.0.1" } });
  await server.listen(); url = server.resolvedUrls!.local[0] + "e2e/fixtures/stream.html";
});

test("preview provenance follows user text, deletions and terminal updates", async ({ page }) => {
  await page.goto(url); await page.waitForFunction(() => "streamCache" in window);
  const result = await page.evaluate(async () => {
    const localeModule = "/src/i18n.ts", previewModule = "/src/conversation-preview.ts";
    const { setLocale } = await import(/* @vite-ignore */ localeModule);
    const { conversationActivityPreview } = await import(/* @vite-ignore */ previewModule);
    setLocale("en");
    const cache = (window as unknown as { streamCache: ClientCache }).streamCache;
    const run = { version: 1, id: "run", revision: 1, phase: "thinking", startedAt: 1, updatedAt: 1, count: 0, completed: 0, failed: 0, truncated: false };
    const reply: Message = { id: "reply", conversationId: "chat", authorType: "bot", authorId: "bot", status: "streaming", version: 1, createdAt: 1,
      blocks: [{ type: "card", summary: "任务处理中", elements: [], extra: { nativeRun: run } }] };
    const user: Message = { ...reply, id: "user", authorType: "user", status: "complete", createdAt: 2, blocks: [{ type: "text", text: "任务处理中" }] };
    let seq = 0;
    const previews: string[] = [];
    const apply = async (message: Message, kind: "message.created" | "message.updated") => {
      await cache.apply({ v: 1, type: "event", conversationId: "chat", seq: ++seq, kind, payload: message, at: seq });
      previews.push(conversationActivityPreview((await cache.activity()).chat));
    };
    await apply(reply, "message.created");
    await apply(user, "message.created");
    await apply({ ...user, status: "deleted", version: 2 }, "message.updated");
    await apply({ ...reply, status: "complete", version: 2, blocks: [{ type: "card", summary: "任务处理中", elements: [], extra: { nativeRun: { ...run, phase: "done" } } }] }, "message.updated");
    await apply({ ...reply, status: "deleted", version: 3 }, "message.updated");
    return { previews, activity: (await cache.activity()).chat };
  });
  expect(result.previews).toEqual(["Task is running", "任务处理中", "Task is running", "任务处理中", ""]);
  expect(result.activity).toMatchObject({ previewStatus: null, lastContentSeq: 0 });
});

test("old cache recovers only matching active native previews without scanning history", async ({ page }) => {
  await page.goto(url); await page.waitForFunction(() => "streamCache" in window);
  const result = await page.evaluate(async () => {
    const localeModule = "/src/i18n.ts", previewModule = "/src/conversation-preview.ts";
    const { setLocale } = await import(/* @vite-ignore */ localeModule);
    const { conversationActivityPreview } = await import(/* @vite-ignore */ previewModule);
    setLocale("en");
    const cache = (window as unknown as { streamCache: ClientCache }).streamCache;
    const request = indexedDB.open(cache.databaseName);
    const db = await new Promise<IDBDatabase>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const tx = db.transaction(["messages", "activity"], "readwrite");
    const run = { version: 1, id: "run", revision: 1, phase: "thinking", startedAt: 1, updatedAt: 1, count: 0, completed: 0, failed: 0, truncated: false };
    for (const conversationId of ["active", "pending", "authored", "terminal", "stale"]) {
      tx.objectStore("activity").put({ preview: "任务处理中", at: 1, unread: {}, lastContentSeq: 1, attention: {}, replies: {}, workingReplies: {} }, conversationId);
      tx.objectStore("messages").put({ id: conversationId, conversationId, authorType: conversationId === "authored" ? "user" : "bot", authorId: "bot", status: conversationId === "terminal" ? "complete" : conversationId === "pending" ? "pending" : "streaming", version: 1, createdAt: 1, activitySeq: conversationId === "stale" ? 2 : 1,
        blocks: [{ type: "card", summary: "任务处理中", elements: [], extra: { nativeRun: run } }] });
    }
    for (let i = 0; i < 200; i++) tx.objectStore("messages").put({ id: `history-${i}`, conversationId: "active", authorType: "bot", authorId: "bot", status: "complete", createdAt: i, version: 1, blocks: [{ type: "text", text: "historical reply" }] });
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
    db.close();
    const reads: unknown[] = [], original = IDBIndex.prototype.getAll;
    IDBIndex.prototype.getAll = function(...args) { if (this.objectStore.name === "messages") reads.push([this.name, args[0]]); return original.apply(this, args); };
    try {
      const activity = await cache.activity();
      const previews = Object.fromEntries(Object.entries(activity).map(([id, row]) => [id, conversationActivityPreview(row)]));
      const firstReads = [...reads]; reads.length = 0;
      await cache.activity();
      return { previews, firstReads, secondReads: reads, authored: activity.authored!.previewStatus, working: activity.pending!.workingReplies };
    } finally { IDBIndex.prototype.getAll = original; }
  });
  expect(result.previews).toEqual({ active: "Task is running", pending: "Task is running", authored: "任务处理中", terminal: "任务处理中", stale: "任务处理中" });
  expect(result.firstReads).toEqual([["status", "streaming"], ["status", "pending"]]);
  expect(result.secondReads).toEqual([]);
  expect(result.authored).toBeNull();
  expect(result.working).toEqual({});
});

for (const width of [1360, 390]) test(`visible conversation preview follows language changes (${width}px)`, async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "run-preview-language-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  try {
    await page.setViewportSize({ width, height: 900 });
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Example Bot','fixture')");
    const chat = await hub.store.createConversation("owner", ["alpha"], "Example chat", "direct");
    await hub.store.publishBotMessage("alpha", { conversationId: chat.id, status: "streaming", blocks: [{ type: "card", summary: "任务处理中", elements: [], extra: { nativeRun: { version: 1, id: "run", revision: 1, phase: "thinking", startedAt: 1, updatedAt: 1, count: 0, completed: 0, failed: 0, truncated: false } } }] });
    await page.goto(hub.url); await preparePairing(page, hub);
    await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await showDisconnectedBots(page);
    await expect(page.getByText("任务处理中", { exact: true }).filter({ visible: true }).first()).toBeVisible();
    await openSettings(page, "general");
    await page.locator("#language").selectOption("en");
    await closeSettings(page, true);
    const showMessages = async () => { if (width < 760) await mobileHome(page).getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: /^Message/ }).click(); };
    await showMessages();
    await expect(page.getByText("Task is running", { exact: true }).filter({ visible: true }).first()).toBeVisible();
    await page.reload(); await showMessages();
    await expect(page.getByText("Task is running", { exact: true }).filter({ visible: true }).first()).toBeVisible();
    if (width < 760) await mobileHome(page).getByRole("button", { name: "Me", exact: true }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).filter({ visible: true }).click();
    await page.getByRole("navigation", { name: "Settings categories" }).getByRole("button", { name: /^General/ }).click();
    await page.locator("#language").selectOption("zh");
    await closeSettings(page);
    if (width < 760) await mobileHome(page).getByRole("navigation", { name: "主导航" }).getByRole("button", { name: /^消息/ }).click();
    await expect(page.getByText("任务处理中", { exact: true }).filter({ visible: true }).first()).toBeVisible();
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
test.afterAll(async () => { await server.close(); });

test("cached run previews follow the UI language without changing reply text", async ({ page }) => {
  await page.goto(url); await page.waitForFunction(() => "streamCache" in window);
  const result = await page.evaluate(async () => {
    const localeModule = "/src/i18n.ts", inboxModule = "/src/conversation-inbox.ts";
    const { setLocale } = await import(/* @vite-ignore */ localeModule);
    const { buildConversationRows } = await import(/* @vite-ignore */ inboxModule);
    const cache = (window as unknown as { streamCache: ClientCache }).streamCache;
    await cache.initializeIdentity({ deviceId: "device", hubPublicKey: "hub", publicKey: "key", name: "Example", routes: [] });
    const run = { version: 1, id: "run", revision: 1, phase: "thinking", startedAt: 1, updatedAt: 1, count: 0, completed: 0, failed: 0, truncated: false };
    const message = { id: "reply", conversationId: "chat", authorType: "bot", authorId: "bot", status: "streaming", version: 1, createdAt: 1,
      blocks: [{ type: "card", summary: "任务处理中", elements: [{ type: "markdown", text: "**任务处理中...**" }, { type: "markdown", text: "中文回复保留原文。" }], extra: { nativeRun: run } }] };
    await cache.apply({ v: 1, type: "event", conversationId: "chat", seq: 1, kind: "message.created", payload: message, at: 1 });
    const activity = await cache.activity();
    const host = { id: "host", name: "Example", bots: [], pins: [], activity, conversations: [{ id: "chat", type: "direct", title: "Example", botIds: ["bot"], createdAt: 1 }] };
    const previews = [];
    for (const locale of ["zh", "en", "zh"]) { setLocale(locale); previews.push(buildConversationRows([host])[0].preview); }
    return { previews, stored: activity.chat!.preview, blocks: (await cache.messages("chat"))[0]!.blocks };
  });
  expect(result.previews).toEqual(["任务处理中", "Task is running", "任务处理中"]);
  expect(result.stored).toBe("任务处理中");
  expect(result.blocks[0]).toMatchObject({ summary: "任务处理中", elements: [{ text: "**任务处理中...**" }, { text: "中文回复保留原文。" }] });
});
