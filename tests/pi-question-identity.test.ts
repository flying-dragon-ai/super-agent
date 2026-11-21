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
import { piDialogQuestion, piDialogResponse } from "../src/codex/pi-turn-mapper.js";
import type { PiExtensionUiRequest } from "../src/codex/pi-rpc-protocol.js";
import { fakePiModel, fakePiSpawner, type FakePiOptions } from "./helpers/pi-fake-rpc.js";

/**
 * Pi questions through the real shared question card (gateway profile, as the
 * App uses it): the card trims labels and question text and reports answers
 * by label, so Pi takes the picked options by position.
 */

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

function appCard() {
  const runtime = createCoreServiceRuntime(), cards = new Map<string, unknown>();
  let serial = 0;
  const channel: CoreChannelLike = {
    profile: "gateway",
    send: async (_to, input) => { const id = `card_${++serial}`; if (typeof input === "object" && input && "card" in input) cards.set(id, input.card); return { messageId: id }; },
    stream: async () => { throw new Error("unexpected_stream"); }, updateCard: async (id, card) => { cards.set(id, card); },
    recallMessage: async id => { cards.delete(id); }, downloadResource: async () => Buffer.alloc(0),
  };
  const asked: EngineApprovalRequest[] = [];
  const decisions: EngineApprovalDecision[] = [];
  const onApprovalRequest = async (request: EngineApprovalRequest) => {
    asked.push(request);
    const decision = await withChannelProfile("gateway", () => requestCoreApproval({ channel, runtime, chatId: "fixture", abortSignal: request.abortSignal, request }));
    decisions.push(decision);
    return decision;
  };
  /** Submit the open card the way the App form does: option positions in `q0`, free text in `q0_other`. */
  const submit = async (form: Record<string, unknown>) => {
    for (let attempt = 0; attempt < 400; attempt++) {
      const pending = [...runtime.pendingApprovals.entries()].find(([, entry]) => entry.managedCard);
      if (pending) {
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
  return { onApprovalRequest, submit, asked, decisions };
}

async function adapterWith(pi: FakePiOptions) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-qid-")), stateDir = path.join(root, "state"), workspace = path.join(root, "ws");
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
  return { adapter, spawner };
}

const message = (text: string, extra: Partial<CodexUserMessageInput> = {}): CodexUserMessageInput => ({ text, authoredText: text, files: [], locale: "en", ...extra } as CodexUserMessageInput);

/** One extension dialog answered through the card; returns what the extension received. */
async function answerDialog(request: Record<string, unknown>, form: Record<string, unknown>, locale: "en" | "zh" = "en") {
  const card = appCard();
  const { adapter, spawner } = await adapterWith({ onPrompt: run => { run.process.ui(request); run.process.once("ui-response", () => { run.reply("done"); run.finish(); }); } });
  const { sessionId } = await adapter.createSession(1);
  const turn = adapter.sendUserMessage(sessionId, message("go", { locale, onApprovalRequest: card.onApprovalRequest }));
  await card.submit(form);
  await turn;
  return { received: spawner.last().uiResponses[0], card };
}

describe("Pi extension dialogs through the shared question card", () => {
  it.each([
    ["an input titled with a trailing space", { id: "d", method: "input", title: "Commit message: " }, { q0_other: "fix the bug" }, { value: "fix the bug" }],
    ["a confirm titled with a trailing newline", { id: "d", method: "confirm", title: "Delete the build folder?\n", message: "irreversible" }, { q0: "0" }, { confirmed: true }],
    ["a confirm answered No", { id: "d", method: "confirm", title: "Proceed?" }, { q0: "1" }, { confirmed: false }],
    ["a select option with a trailing space", { id: "d", method: "select", title: "Pick", options: ["Keep ", "Drop"] }, { q0: "0" }, { value: "Keep " }],
    ["select options equal once trimmed", { id: "d", method: "select", title: "Pick", options: ["A", "A "] }, { q0: "1" }, { value: "A " }],
    ["a select option containing a comma", { id: "d", method: "select", title: "Pick", options: ["red, green", "blue"] }, { q0: "0" }, { value: "red, green" }],
    ["a blank title and a blank option", { id: "d", method: "select", title: "  ", options: ["  ", "B"] }, { q0: "0" }, { value: "  " }],
    ["an editor emptied on purpose", { id: "d", method: "editor", title: "Edit: ", prefill: "old" }, { q0_other: "" }, { value: "" }],
  ])("returns the owner's answer for %s", async (_name, request, form, expected) => {
    const { received } = await answerDialog(request, form);
    expect(received).toEqual({ type: "extension_ui_response", id: "d", ...expected });
  });

  it("keeps visible text unchanged, and gives blank text a placeholder so no option is dropped", async () => {
    const { card } = await answerDialog({ id: "d", method: "select", title: "", options: ["", "B "] }, { q0: "1" }, "zh");
    const question = (card.asked[0]!.toolInput as { questions: Array<{ question: string; options: Array<{ label: string }> }> }).questions[0]!;
    expect(question.question).toBe("Pi 扩展问题");
    expect(question.options.map(option => option.label)).toEqual(["（空）", "B "]);
  });
});

describe("Pi native command choices through the shared question card", () => {
  it("forks at the entry the owner picked when two user messages have the same text", async () => {
    const forked: string[] = [];
    const card = appCard();
    const { adapter } = await adapterWith({
      onCommand: (command, process) => {
        if (command.type === "get_fork_messages") { process.respond(command, { messages: [{ entryId: "u1", text: "continue" }, { entryId: "u2", text: "something else" }, { entryId: "u3", text: "continue" }] }); return true; }
        if (command.type === "fork") { forked.push(String(command.entryId)); process.state.sessionId = "forked-session"; process.respond(command, { text: "continue", cancelled: false }); return true; }
      },
    });
    const { sessionId } = await adapter.createSession(1);
    for (const [row, entry] of [["2", "u1"], ["0", "u3"]] as const) {
      const turn = adapter.sendUserMessage(row === "2" ? sessionId : "forked-session", message("/fork", { onApprovalRequest: card.onApprovalRequest }));
      // Newest first: [u3 "continue", u2, u1 "continue"]. The labels shown are unchanged.
      await card.submit({ q0: row });
      expect((await turn).sessionId).toBe("forked-session");
      expect(forked.at(-1)).toBe(entry);
    }
    const shown = (card.asked[0]!.toolInput as { questions: Array<{ options: Array<{ label: string }> }> }).questions[0]!.options.map(option => option.label);
    expect(shown).toEqual(["continue", "something else", "continue"]);
  });

  it("never guesses between equal labels when an answer carries labels only", async () => {
    const forked: string[] = [];
    const { adapter } = await adapterWith({
      onCommand: (command, process) => {
        if (command.type === "get_fork_messages") { process.respond(command, { messages: [{ entryId: "u1", text: "continue" }, { entryId: "u2", text: "continue" }] }); return true; }
        if (command.type === "fork") { forked.push(String(command.entryId)); process.respond(command, { text: "", cancelled: false }); return true; }
      },
    });
    const { sessionId } = await adapter.createSession(1);
    const labelsOnly = async (request: EngineApprovalRequest): Promise<EngineApprovalDecision> => {
      const question = (request.toolInput as { questions: Array<{ question: string }> }).questions[0]!.question;
      return { behavior: "allow", updatedInput: { answers: { [question]: "continue" } } };
    };
    const result = await adapter.sendUserMessage(sessionId, message("/fork", { onApprovalRequest: labelsOnly }));
    expect(forked).toEqual([]);
    expect(result.text).toBe("Cancelled. Nothing was changed.");
  });

  it("adds positions for Pi only; every other engine keeps its answer contract", async () => {
    // Antigravity has no question card (card-actions isAskUserQuestionRequest); its approval carries no answers at all.
    for (const engine of ["pi", "claude", "codex", "kimi", "deepseek"] as const) {
      const card = appCard();
      const pending = card.onApprovalRequest({ engine, toolName: "AskUserQuestion", toolInput: { questions: [{ question: "Pick", header: "Q", multiSelect: true, options: [{ label: "A" }, { label: "A " }, { label: "B" }] }] } });
      await card.submit({ q0: ["1", "2"] });
      const decision = await pending;
      expect(decision, engine).toMatchObject({ behavior: "allow", updatedInput: { answers: { Pick: "A, B" } } });
      const updated = (decision as { updatedInput: Record<string, unknown> }).updatedInput;
      if (engine === "pi") expect(updated.selections).toEqual([{ options: [1, 2] }]);
      else expect(updated, engine).not.toHaveProperty("selections");
    }
  });
});

describe("label-only answers never pick between labels the card shows alike", () => {
  const labelOnly = (options: string[], answer: string) => {
    const request = { type: "extension_ui_request", id: "d", method: "select", title: "Pick", options } as unknown as PiExtensionUiRequest;
    return piDialogResponse(request, piDialogQuestion(request)!, { answers: { Pick: answer } });
  };

  it("cancels an extension choice whose trimmed label matches more than one option", () => {
    expect(labelOnly(["A", "A "], "A")).toEqual({ type: "extension_ui_response", id: "d", cancelled: true });
    expect(labelOnly(["A ", " A"], "A")).toEqual({ type: "extension_ui_response", id: "d", cancelled: true });
    // One option string offered twice is still one value; a single trimmed match is that option, exactly.
    expect(labelOnly(["A", "A"], "A")).toEqual({ type: "extension_ui_response", id: "d", value: "A" });
    expect(labelOnly([" A", "B"], "A")).toEqual({ type: "extension_ui_response", id: "d", value: " A" });
  });

  it("cancels a native command choice whose trimmed label matches more than one option", async () => {
    const models = [fakePiModel("fakeprov", "m"), fakePiModel("fakeprov", "m ")];
    const { adapter, spawner } = await adapterWith({ models, model: models[0] });
    const { sessionId } = await adapter.createSession(1);
    const labelsOnly = async (request: EngineApprovalRequest): Promise<EngineApprovalDecision> => {
      const question = (request.toolInput as { questions: Array<{ question: string }> }).questions[0]!.question;
      return { behavior: "allow", updatedInput: { answers: { [question]: "fakeprov/m" } } };
    };
    const result = await adapter.sendUserMessage(sessionId, message("/model", { onApprovalRequest: labelsOnly }));
    expect(spawner.last().received.filter(command => command.type === "set_model")).toEqual([]);
    expect(result.text).toBe("Cancelled. Nothing was changed.");
  });
});
