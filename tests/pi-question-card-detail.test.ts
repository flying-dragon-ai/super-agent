import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { CodexUserMessageInput, EngineApprovalDecision, EngineApprovalRequest } from "../src/codex/adapter.js";
import { PiRpcAdapter } from "../src/codex/pi-rpc-adapter.js";
import { handleCoreCardAction, requestCoreApproval } from "../src/core/card-actions.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import type { CoreChannelLike } from "../src/core/types.js";
import { withChannelProfile } from "../src/gateway/platform-profile.js";
import { fakePiSpawner, type FakePiOptions } from "./helpers/pi-fake-rpc.js";

/**
 * What the owner is asked to confirm has to be on the card. The shared
 * question card shows a question's title and options; a Pi question's
 * explanation used to travel in a field the card does not render.
 */

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => {}); });

/** The real shared approval card under the App profile; `submit` answers the card that is waiting. */
function appCard(locale: "en" | "zh" = "en") {
  const runtime = createCoreServiceRuntime(), cards = new Map<string, unknown>(), history: unknown[] = [];
  let serial = 0;
  const channel: CoreChannelLike = {
    profile: "gateway",
    send: async (_to, input) => { const id = `card_${++serial}`; if (typeof input === "object" && input && "card" in input) { cards.set(id, input.card); history.push(input.card); } return { messageId: id }; },
    stream: async () => { throw new Error("unexpected_stream"); }, updateCard: async (id, card) => { cards.set(id, card); },
    recallMessage: async id => { cards.delete(id); }, downloadResource: async () => Buffer.alloc(0),
  };
  const onApprovalRequest = async (request: EngineApprovalRequest): Promise<EngineApprovalDecision> =>
    withChannelProfile("gateway", () => requestCoreApproval({ channel, runtime, chatId: "fixture", abortSignal: request.abortSignal, request, locale }));
  const submitted = new Set<string>();
  const submit = async (form: Record<string, unknown>) => {
    for (let attempt = 0; attempt < 400; attempt++) {
      const pending = [...runtime.pendingApprovals.entries()].find(([id, entry]) => entry.managedCard && !submitted.has(id));
      if (pending) {
        submitted.add(pending[0]);
        await withChannelProfile("gateway", () => handleCoreCardAction({ channel, runtime, event: {
          messageId: [...cards.keys()].at(-1)!, chatId: "fixture",
          action: { value: { cctb_lark: "ask_user_question", action: "form_submit", requestId: pending[0] }, form_value: form },
        } }));
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error("no question card was shown");
  };
  /** The text an owner can read on the n-th card: its markdown, and the question the App renders natively. */
  const shown = (index = 0) => {
    const texts: string[] = [];
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) { value.forEach(walk); return; }
      if (!value || typeof value !== "object") return;
      const node = value as Record<string, unknown>;
      if (node.tag === "markdown" && typeof node.content === "string") texts.push(node.content);
      const native = node.open_super_agent_questions as { questions?: Array<{ question?: unknown }> } | undefined;
      for (const question of native?.questions ?? []) if (typeof question.question === "string") texts.push(`native:${question.question}`);
      Object.values(node).forEach(walk);
    };
    walk(history[index]);
    return texts;
  };
  return { onApprovalRequest, submit, shown, history };
}

async function adapterWith(pi: FakePiOptions = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-card-detail-")), stateDir = path.join(root, "state"), workspace = path.join(root, "ws");
  await mkdir(stateDir, { recursive: true }); await mkdir(workspace, { recursive: true });
  const configPath = path.join(stateDir, "config.json");
  await writeFile(configPath, JSON.stringify({ engine: "pi", approvalMode: "bypass" }));
  const spawner = fakePiSpawner(pi);
  const adapter = new PiRpcAdapter({
    launch: { command: "pi", args: [] }, workspacePath: workspace, stateDir, configPath, childEnv: {}, bridgeExtensionPath: null,
    spawnFn: spawner.spawn, killProcessTreeFn: () => {}, queryCatalogFn: async () => ({ models: [] }),
    idleSweepIntervalMs: 0, cancelGraceMs: 80, startupTimeoutMs: 500, turnTimeoutMs: null, inactivityTimeoutMs: null,
  });
  cleanups.push(async () => { await adapter.destroy(); await rm(root, { recursive: true, force: true }); });
  return { adapter, spawner, sessionId: (await adapter.createSession(1)).sessionId };
}

const message = (text: string, extra: Partial<CodexUserMessageInput> = {}): CodexUserMessageInput => ({ text, authoredText: text, files: [], locale: "en", ...extra } as CodexUserMessageInput);
/** On both surfaces: the card's own markdown and the question the App draws. */
const everywhere = (texts: string[], needle: string) => texts.some(text => !text.startsWith("native:") && text.includes(needle)) && texts.some(text => text.startsWith("native:") && text.includes(needle));

describe("what a Pi question card shows", () => {
  it("says which global setting changes, to what, and for whom, before the owner confirms", async () => {
    const card = appCard();
    const { adapter, spawner, sessionId } = await adapterWith();
    const turn = adapter.sendUserMessage(sessionId, message("/settings steering all", { onApprovalRequest: card.onApprovalRequest }));
    await card.submit({ q0: "1" }); // "Keep the current value"
    await turn;
    const texts = card.shown();
    expect(everywhere(texts, "Change global Pi setting")).toBe(true);
    expect(everywhere(texts, "all at once")).toBe(true);
    expect(everywhere(texts, "every Pi session on this computer, the terminal included")).toBe(true);
    // Declined: nothing was written.
    expect(spawner.last().received.filter(command => command.type === "set_steering_mode")).toEqual([]);
  });

  it("applies the change only for the affirmative option of that same card", async () => {
    const card = appCard();
    const { adapter, spawner, sessionId } = await adapterWith();
    const turn = adapter.sendUserMessage(sessionId, message("/settings steering all", { onApprovalRequest: card.onApprovalRequest }));
    await card.submit({ q0: "0" });
    expect((await turn).text).toContain("Steering mode is now all at once");
    expect(spawner.last().received.filter(command => command.type === "set_steering_mode").map(command => command.mode)).toEqual(["all"]);
  });

  it.each(["en", "zh"] as const)("shows an extension's confirmation message with its title (%s) and returns the chosen answer", async locale => {
    const card = appCard(locale);
    const { adapter, spawner, sessionId } = await adapterWith({
      onPrompt: run => {
        run.process.ui({ id: "c1", method: "confirm", title: "Proceed?", message: "This deletes the build directory fixture-dir." });
        run.process.once("ui-response", () => { run.reply("done"); run.finish(); });
      },
    });
    const turn = adapter.sendUserMessage(sessionId, message("go", { locale, onApprovalRequest: card.onApprovalRequest }));
    await card.submit({ q0: "1" });
    await turn;
    const texts = card.shown();
    expect(everywhere(texts, "Proceed?")).toBe(true);
    expect(everywhere(texts, "This deletes the build directory fixture-dir.")).toBe(true);
    expect(spawner.last().uiResponses).toEqual([{ type: "extension_ui_response", id: "c1", confirmed: false }]);
  });

  it("says that a long list is cut and how to narrow it", async () => {
    const card = appCard();
    const { adapter, spawner, sessionId } = await adapterWith({ onPrompt: run => { run.reply("ok"); run.finish(); } });
    for (let index = 0; index < 33; index++) await adapter.sendUserMessage(sessionId, message(`message number ${index}`));
    const turn = adapter.sendUserMessage(sessionId, message("/fork", { onApprovalRequest: card.onApprovalRequest }));
    await card.submit({ q0: "2" });
    await turn;
    expect(everywhere(card.shown(), "the first 30 are shown")).toBe(true);
    // The third row of that card is the entry that was forked, whatever else the question text now says.
    expect(spawner.last().received.filter(command => command.type === "fork")).toHaveLength(1);
  });
});
