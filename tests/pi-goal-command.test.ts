import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { CodexAdapter } from "../src/codex/adapter.js";
import { handleCoreSimpleCommand } from "../src/core/commands.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import { Bridge, type AccessStoreLike } from "../src/runtime/bridge.js";
import { SessionManager } from "../src/runtime/session-manager.js";
import { SessionStore } from "../src/state/session-store.js";

/**
 * `/goal` is offered in every engine's command menu. Pi has no goal mode and
 * its adapter has no structured goal API; the command has to say so instead of
 * failing a run with a generic error.
 */

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

const key = "lark:goal-chat";
const normalized = (text: string) => ({ text, messageId: text, chatId: "goal-chat", senderId: "owner", bridgeChatId: 1, bridgeAccessChatId: 1, bridgeUserId: 2, bridgeChatType: "private", conversationKey: key, accessConversationKey: key, mentions: [], attachments: [] });

async function run(engine: "pi" | "kimi", locale: "en" | "zh", text: string) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "pi-goal-"));
  roots.push(stateDir);
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine, locale }));
  // The goal surface of the real Pi adapter: none of the structured goal methods.
  const adapter: CodexAdapter = { createSession: vi.fn(async () => ({ sessionId: "stub-session" })) as never, sendUserMessage: vi.fn() as never };
  const bridge = new Bridge({} as AccessStoreLike, new SessionManager(new SessionStore(path.join(stateDir, "sessions.json")), adapter), adapter);
  const sent: string[] = [];
  const channel = { send: vi.fn(async (_to: string, body: { text?: string }) => { sent.push(String(body?.text ?? JSON.stringify(body))); return { messageId: "reply" }; }), recallMessage: vi.fn(async () => {}), addReaction: vi.fn(async () => "r"), removeReaction: vi.fn(async () => {}) };
  const createRunCard = vi.fn(async () => ({ apply: vi.fn(async () => {}), interrupt: vi.fn(async () => {}), finish: vi.fn(async () => ({ shown: true, reason: "fit" as const })), fail: vi.fn(async () => "error" as const), resolveFinalText: vi.fn(() => ""), setPhase: vi.fn(), setGoalObjective: vi.fn() }));
  const input = { stateDir, runtime: createCoreServiceRuntime(), bridge, channel, createRunCard, requestApproval: async () => ({ behavior: "deny" as const }) };
  const handled = await handleCoreSimpleCommand(input as never, normalized(text) as never, text);
  await new Promise(resolve => setTimeout(resolve, 50));
  return { handled, sent, runCards: createRunCard.mock.calls.length, engineCalls: (adapter.sendUserMessage as unknown as { mock: { calls: unknown[] } }).mock.calls.length };
}

describe("/goal on a Pi Bot", () => {
  it.each(["/goal", "/goal finish the fixture task", "/goal clear", "/goal pause", "/goal resume"])("explains that Pi has no goal mode and starts nothing: %s", async text => {
    for (const locale of ["en", "zh"] as const) {
      const outcome = await run("pi", locale, text);
      expect(outcome.handled).toBe(true);
      expect(outcome.sent).toHaveLength(1);
      expect(outcome.sent[0]).toMatch(locale === "en" ? /Pi has no \/goal/ : /Pi 没有 \/goal/);
      expect(outcome.runCards).toBe(0);
      expect(outcome.engineCalls).toBe(0);
    }
  });

  it("keeps Kimi's own explanation", async () => {
    const outcome = await run("kimi", "en", "/goal finish the fixture task");
    expect(outcome).toMatchObject({ handled: true, runCards: 0 });
    expect(outcome.sent[0]).toMatch(/Kimi ACP does not currently provide \/goal/);
  });
});
