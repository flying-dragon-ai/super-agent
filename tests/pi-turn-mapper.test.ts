import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import type { EngineStreamEvent } from "../src/codex/adapter.js";
import {
  parsePiFrame,
  type PiExtensionUiRequest, type PiSessionEvent, type PiSessionTreeNode,
} from "../src/codex/pi-rpc-protocol.js";
import {
  PI_INLINE_IMAGE_MAX_BYTES, PI_INLINE_IMAGE_MAX_COUNT, PiTurnMapper,
  addPiUsage, buildPiPrompt, isPiAssistantMessage, isPiDialog, piDialogQuestion, piDialogResponse, piMessageText,
  piNativeTree, piToolResultText, piUserEntryText,
} from "../src/codex/pi-turn-mapper.js";

const FIXTURE_DIR = fileURLToPath(new URL("./fixtures/pi-rpc/", import.meta.url));
const fixtureLines = (name: string) => readFileSync(path.join(FIXTURE_DIR, name), "utf8").split("\n").filter(Boolean);

function fixtureEvents(name: string): PiSessionEvent[] {
  const events: PiSessionEvent[] = [];
  for (const line of fixtureLines(name)) {
    const frame = parsePiFrame(line);
    if (frame.kind === "event") events.push(frame.event);
  }
  return events;
}

function replay(name: string): { mapper: PiTurnMapper; out: EngineStreamEvent[] } {
  const mapper = new PiTurnMapper("session-under-test");
  const out: EngineStreamEvent[] = [];
  for (const event of fixtureEvents(name)) out.push(...mapper.apply(event));
  return { mapper, out };
}

function feed(mapper: PiTurnMapper, events: Array<Record<string, unknown>>): EngineStreamEvent[] {
  return events.flatMap(event => mapper.apply(event as unknown as PiSessionEvent));
}

/** Compact, order-preserving view of the stream: `text` / `text+` for a block start / continuation. */
const shape = (out: EngineStreamEvent[]) => out.map(event => {
  if (event.type === "assistant_text") return event.delta ? "text+" : "text";
  if (event.type === "thinking") return event.delta ? "thinking+" : "thinking";
  return event.type;
});
const textOf = (out: EngineStreamEvent[], type: "assistant_text" | "thinking") =>
  out.filter((event): event is Extract<EngineStreamEvent, { type: "assistant_text" | "thinking" }> => event.type === type).map(event => event.text).join("");

describe("PiTurnMapper replaying runs recorded from Pi 1.5.2", () => {
  it("maps a plain text reply", () => {
    const { mapper, out } = replay("run-text.jsonl");
    expect(out).toEqual([
      { type: "assistant_text", text: "Hello ", sessionId: "session-under-test" },
      { type: "assistant_text", text: "from ", delta: true, sessionId: "session-under-test" },
      { type: "assistant_text", text: "dup-model", delta: true, sessionId: "session-under-test" },
    ]);
    // The first fragment of a block carries no `delta` key at all.
    expect("delta" in out[0]!).toBe(false);
    expect(mapper.finalText).toBe("Hello from dup-model");
    expect(mapper.currentText).toBe("");
    expect(mapper.runStarted).toBe(true);
    expect(mapper.settled).toEqual({ aborted: false });
    expect(mapper.lastAssistant).toMatchObject({ role: "assistant", provider: "fakeprov2", model: "dup-model", stopReason: "stop" });
    // input is uncached input; cache reads and writes are reported apart.
    expect(mapper.usage).toEqual({ inputTokens: 80, outputTokens: 20, cachedTokens: 40, costUsd: expect.closeTo(0.000124, 9) });
    expect(mapper.hasOpenTools).toBe(false);
  });

  it("starts a thinking block with delta:false and continues it with delta:true", () => {
    const { mapper, out } = replay("run-thinking.jsonl");
    expect(shape(out)).toEqual(["thinking", "thinking+", "text", "text+", "text+"]);
    expect(out[0]).toEqual({ type: "thinking", text: "Let me ", delta: false, sessionId: "session-under-test" });
    expect(out[1]).toEqual({ type: "thinking", text: "think.", delta: true, sessionId: "session-under-test" });
    expect(textOf(out, "thinking")).toBe("Let me think.");
    expect(textOf(out, "assistant_text")).toBe("Hello from dup-model");
    // Thinking text is never part of the answer.
    expect(mapper.finalText).toBe("Hello from dup-model");
    expect(mapper.usage).toMatchObject({ inputTokens: 100, outputTokens: 20, cachedTokens: 40 });
  });

  it("maps a tool call, its partial output and its result, then the reply", () => {
    const { mapper, out } = replay("run-tool.jsonl");
    expect(out).toEqual([
      { type: "tool_use", toolName: "bash", toolInput: { command: "echo tool-ran" }, toolUseId: "call_fake_3", sessionId: "session-under-test" },
      // The first partial result was empty and produced nothing.
      { type: "tool_progress", toolUseId: "call_fake_3", text: "tool-ran\n", delta: false, sessionId: "session-under-test" },
      { type: "tool_result", toolUseId: "call_fake_3", toolName: "bash", output: "tool-ran\n", isError: false, durationMs: 5, exitCode: 0, sessionId: "session-under-test" },
      { type: "assistant_text", text: "tool result seen by dup-model", sessionId: "session-under-test" },
    ]);
    expect(mapper.finalText).toBe("tool result seen by dup-model");
    // Two assistant messages (the tool call and the reply) are summed.
    expect(mapper.usage).toEqual({ inputTokens: 260, outputTokens: 40, cachedTokens: 80, costUsd: expect.closeTo(0.000348, 9) });
    expect(mapper.hasOpenTools).toBe(false);
  });

  it("keeps one stream across a steer and a follow-up in the same run", () => {
    const events = fixtureEvents("run-steer-followup.jsonl");
    const mapper = new PiTurnMapper("session-under-test");
    const out: EngineStreamEvent[] = [];
    let settledSeenAfter = -1;
    events.forEach((event, index) => {
      out.push(...mapper.apply(event));
      if (mapper.settled && settledSeenAfter < 0) settledSeenAfter = index;
    });
    // Three assistant messages: the slow one (30 fragments), the steer reply and the follow-up reply.
    expect(shape(out)).toEqual(["text", ...Array.from({ length: 29 }, () => "text+"), "text", "text+", "text+", "text", "text+", "text+"]);
    expect(out.every(event => event.type === "assistant_text")).toBe(true); // queue and thinking-level records are not engine events
    expect(mapper.finalText).toBe("Hello from plain-model");
    expect(mapper.lastAssistant).toMatchObject({ provider: "fakeprov", model: "plain-model" });
    expect(mapper.usage).toMatchObject({ inputTokens: 160 + 180 + 200, outputTokens: 60, cachedTokens: 120 });
    // Only agent_settled, the very last record, ends the run.
    expect(settledSeenAfter).toBe(events.length - 1);
    expect(mapper.settled).toEqual({ aborted: false });
  });

  it("does not present an aborted reply as the answer", () => {
    const { mapper, out } = replay("run-abort.jsonl");
    expect(out).toEqual([{ type: "assistant_text", text: "slow0 ", sessionId: "session-under-test" }]);
    expect(mapper.finalText).toBe("");
    expect(mapper.currentText).toBe("");
    expect(mapper.settled).toEqual({ aborted: true });
    expect(mapper.lastAssistant).toMatchObject({ stopReason: "aborted", errorMessage: "Request was aborted" });
    // Zero usage is still usage, and a zero cost is left out.
    expect(mapper.usage).toEqual({ inputTokens: 0, outputTokens: 0, cachedTokens: 0 });
  });

  it("reports a provider error through the last assistant message only", () => {
    const { mapper, out } = replay("run-error.jsonl");
    expect(out).toEqual([]);
    expect(mapper.finalText).toBe("");
    expect(mapper.runStarted).toBe(true);
    expect(mapper.settled).toEqual({ aborted: false });
    expect(mapper.lastAssistant).toMatchObject({ stopReason: "error", errorMessage: '401: {"message":"fake invalid api key"}' });
  });

  it("maps Pi's own retry wait and its cancellation", () => {
    const { mapper, out } = replay("run-error-retry.jsonl");
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ type: "engine_retry", status: "waiting", attempt: 1, delayMs: 2000, sessionId: "session-under-test" });
    expect(out[1]).toMatchObject({ type: "engine_retry", status: "cancelled", attempt: 1, delayMs: 0, sessionId: "session-under-test" });
    for (const event of out) expect(["capacity", "connection", "rate-limit"]).toContain((event as { reason: string }).reason);
    expect(mapper.settled).toEqual({ aborted: false });
    expect(mapper.lastAssistant?.stopReason).toBe("error");
  });

  it("maps a user message that carries an image like any other run", () => {
    const { mapper, out } = replay("run-image.jsonl");
    expect(shape(out)).toEqual(["text", "text+", "text+"]);
    expect(mapper.finalText).toBe("Hello from dup-model");
  });

  it("maps a tool call an extension blocked as a failed result without progress", () => {
    const { mapper, out } = replay("run-tool-denied.jsonl");
    expect(shape(out)).toEqual(["tool_use", "tool_result", "text"]);
    expect(out[1]).toEqual({ type: "tool_result", toolUseId: "call_fake_3", toolName: "bash", output: "Denied in Open Super Agent", isError: true, sessionId: "session-under-test" });
    expect(mapper.finalText).toBe("tool result seen by dup-model");
  });

  it("maps a run aborted while a tool call was waiting", () => {
    const { mapper, out } = replay("run-tool-aborted.jsonl");
    expect(shape(out)).toEqual(["tool_use", "tool_result"]);
    expect(out[1]).toMatchObject({ type: "tool_result", toolUseId: "call_fake_7", output: "Operation aborted", isError: true });
    expect(mapper.finalText).toBe("");
    expect(mapper.settled).toEqual({ aborted: true });
    expect(mapper.lastAssistant?.stopReason).toBe("aborted");
    expect(mapper.hasOpenTools).toBe(false);
    // The tool-call message was billed before the abort.
    expect(mapper.usage).toMatchObject({ inputTokens: 200, outputTokens: 20, cachedTokens: 40 });
  });

  it("maps a refused compaction and leaves non-run records alone", () => {
    const { mapper, out } = replay("noauth-responses.jsonl");
    expect(out).toEqual([
      { type: "context_compaction", id: "pi-compaction-1", status: "started", sessionId: "session-under-test" },
      { type: "context_compaction", id: "pi-compaction-1", status: "failed", durationMs: expect.any(Number), sessionId: "session-under-test" },
    ]);
    expect(mapper.runStarted).toBe(false);
    expect(mapper.settled).toBeUndefined();
    expect(mapper.usage).toBeUndefined();
  });
});

describe("PiTurnMapper on constructed events", () => {
  const assistantEnd = (text: string, extra: Record<string, unknown> = {}) => ({
    type: "message_end", message: { role: "assistant", content: text ? [{ type: "text", text }] : [], stopReason: "stop", ...extra },
  });
  const update = (assistantMessageEvent: Record<string, unknown>) => ({ type: "message_update", assistantMessageEvent });

  it("publishes the whole text at message_end when the provider sent no deltas", () => {
    const mapper = new PiTurnMapper("s");
    const out = feed(mapper, [{ type: "message_start", message: { role: "assistant", content: [] } }, assistantEnd("all at once")]);
    expect(out).toEqual([{ type: "assistant_text", text: "all at once", sessionId: "s" }]);
    expect(mapper.finalText).toBe("all at once");
  });

  it("does not repeat text at message_end that was already streamed", () => {
    const mapper = new PiTurnMapper("s");
    const out = feed(mapper, [
      { type: "message_start", message: { role: "assistant", content: [] } },
      update({ type: "text_start", contentIndex: 0 }), update({ type: "text_delta", contentIndex: 0, delta: "streamed" }),
      assistantEnd("streamed"),
    ]);
    expect(out).toHaveLength(1);
  });

  it("opens a new block for every text_start and thinking_start, within and across messages", () => {
    const mapper = new PiTurnMapper("s");
    const out = feed(mapper, [
      { type: "message_start", message: { role: "assistant", content: [] } },
      update({ type: "thinking_start", contentIndex: 0 }), update({ type: "thinking_delta", contentIndex: 0, delta: "a" }), update({ type: "thinking_delta", contentIndex: 0, delta: "b" }),
      update({ type: "text_start", contentIndex: 1 }), update({ type: "text_delta", contentIndex: 1, delta: "c" }), update({ type: "text_delta", contentIndex: 1, delta: "d" }),
      update({ type: "thinking_start", contentIndex: 2 }), update({ type: "thinking_delta", contentIndex: 2, delta: "e" }),
      update({ type: "text_start", contentIndex: 3 }), update({ type: "text_delta", contentIndex: 3, delta: "f" }),
      assistantEnd("cdf"),
      { type: "message_start", message: { role: "assistant", content: [] } },
      update({ type: "text_start", contentIndex: 0 }), update({ type: "text_delta", contentIndex: 0, delta: "g" }),
      assistantEnd("g"),
    ]);
    expect(shape(out)).toEqual(["thinking", "thinking+", "text", "text+", "thinking", "text", "text"]);
    expect(mapper.finalText).toBe("g");
  });

  it("ignores empty deltas and updates it has no mapping for", () => {
    const mapper = new PiTurnMapper("s");
    const out = feed(mapper, [
      { type: "message_start", message: { role: "assistant", content: [] } },
      update({ type: "start" }), update({ type: "text_start", contentIndex: 0 }), update({ type: "text_delta", contentIndex: 0, delta: "" }),
      update({ type: "toolcall_start", contentIndex: 1, id: "c1", toolName: "bash" }), update({ type: "toolcall_delta", contentIndex: 1, delta: "{" }),
      update({ type: "toolcall_end", contentIndex: 1, toolCall: { type: "toolCall", id: "c1", name: "bash", arguments: {} } }),
      update({ type: "text_end", contentIndex: 0, content: "" }), update({ type: "done" }),
      { type: "unknown", originalType: "future", raw: {} }, { type: "turn_start" }, { type: "queue_update", steering: ["x"], followUp: [] },
      { type: "entry_appended", entry: { type: "custom", id: "e", parentId: null } },
    ]);
    expect(out).toEqual([]);
  });

  it("keeps the text of the last completed answer when a later message has none or fails", () => {
    const mapper = new PiTurnMapper("s");
    feed(mapper, [assistantEnd("first answer"), assistantEnd("", { stopReason: "toolUse" })]);
    expect(mapper.finalText).toBe("first answer");
    feed(mapper, [assistantEnd("half an ans", { stopReason: "error", errorMessage: "boom" })]);
    expect(mapper.finalText).toBe("first answer");
    expect(mapper.lastAssistant).toMatchObject({ stopReason: "error", errorMessage: "boom" });
    feed(mapper, [assistantEnd("cut off by the limit", { stopReason: "length" })]);
    expect(mapper.finalText).toBe("cut off by the limit");
  });

  it("does not treat user, tool-result or system messages as the assistant's", () => {
    const mapper = new PiTurnMapper("s");
    const out = feed(mapper, [
      { type: "message_start", message: { role: "system", content: "s" } }, { type: "message_end", message: { role: "system", content: "s" } },
      { type: "message_start", message: { role: "user", content: "question" } }, { type: "message_end", message: { role: "user", content: "question" } },
      { type: "message_end", message: { role: "toolResult", toolCallId: "c", toolName: "bash", content: [{ type: "text", text: "out" }] } },
    ]);
    expect(out).toEqual([]);
    expect(mapper.finalText).toBe("");
    expect(mapper.lastAssistant).toBeUndefined();
    expect(mapper.usage).toBeUndefined();
  });

  it("publishes a tool call once even if its start is repeated", () => {
    const mapper = new PiTurnMapper("s");
    const start = { type: "tool_execution_start", toolCallId: "c1", toolName: "edit", args: { path: "a.txt" } };
    const out = feed(mapper, [start, start]);
    expect(shape(out)).toEqual(["tool_use"]);
    expect(mapper.hasOpenTools).toBe(true);
  });

  it("publishes only the new suffix of cumulative partial results", () => {
    const mapper = new PiTurnMapper("s");
    const partial = (text: string) => ({ type: "tool_execution_update", toolCallId: "c1", toolName: "bash", args: {}, partialResult: { content: [{ type: "text", text }] } });
    const out = feed(mapper, [
      { type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "x" } },
      partial(""), partial("a"), partial("a"), partial("ab"), partial("abc"),
      partial("replaced"), // not an extension of what came before: published whole
      partial("replaced more"),
    ]);
    expect(out.slice(1)).toEqual([
      { type: "tool_progress", toolUseId: "c1", text: "a", delta: false, sessionId: "s" },
      { type: "tool_progress", toolUseId: "c1", text: "b", delta: true, sessionId: "s" },
      { type: "tool_progress", toolUseId: "c1", text: "c", delta: true, sessionId: "s" },
      { type: "tool_progress", toolUseId: "c1", text: "replaced", delta: false, sessionId: "s" },
      { type: "tool_progress", toolUseId: "c1", text: " more", delta: true, sessionId: "s" },
    ]);
  });

  it("drops partial results of a call it never saw start", () => {
    const mapper = new PiTurnMapper("s");
    expect(feed(mapper, [{ type: "tool_execution_update", toolCallId: "ghost", toolName: "bash", args: {}, partialResult: { content: [{ type: "text", text: "x" }] } }])).toEqual([]);
  });

  it("shows calls a tool made itself inside the parent call, never as calls of their own", () => {
    const mapper = new PiTurnMapper("s");
    const out = feed(mapper, [
      { type: "tool_execution_start", toolCallId: "p1", toolName: "codemode", args: { script: "…" } },
      { type: "tool_execution_start", toolCallId: "p1/1", toolName: "read", args: { path: "a.txt" }, parentToolCallId: "p1" },
      { type: "tool_execution_update", toolCallId: "p1/1", toolName: "read", args: {}, partialResult: { content: [{ type: "text", text: "partial" }] }, parentToolCallId: "p1" },
      { type: "tool_execution_end", toolCallId: "p1/1", toolName: "read", result: { content: [{ type: "text", text: "file body" }] }, isError: false, parentToolCallId: "p1" },
      { type: "tool_execution_start", toolCallId: "p1/2", toolName: "bash", args: { command: "false" }, parentToolCallId: "p1" },
      { type: "tool_execution_end", toolCallId: "p1/2", toolName: "bash", result: { content: [{ type: "text", text: "exit 1" }] }, isError: true, parentToolCallId: "p1" },
      { type: "tool_execution_end", toolCallId: "p1", toolName: "codemode", result: { content: [{ type: "text", text: "script done" }] }, isError: false, durationMs: 12 },
    ]);
    expect(out).toEqual([
      { type: "tool_use", toolName: "codemode", toolInput: { script: "…" }, toolUseId: "p1", sessionId: "s" },
      { type: "tool_progress", toolUseId: "p1", text: 'read {"path":"a.txt"}\n', delta: false, sessionId: "s" },
      { type: "tool_progress", toolUseId: "p1", text: 'bash {"command":"false"}\n', delta: false, sessionId: "s" },
      { type: "tool_progress", toolUseId: "p1", text: "bash failed: exit 1\n", delta: false, sessionId: "s" },
      { type: "tool_result", toolUseId: "p1", toolName: "codemode", output: "script done", isError: false, durationMs: 12, sessionId: "s" },
    ]);
    expect(out.filter(event => event.type === "tool_use")).toHaveLength(1);
    expect(mapper.hasOpenTools).toBe(false);
  });

  it("bounds the arguments it prints for a nested call", () => {
    const mapper = new PiTurnMapper("s");
    const [, progress] = feed(mapper, [
      { type: "tool_execution_start", toolCallId: "p", toolName: "codemode", args: {} },
      { type: "tool_execution_start", toolCallId: "p/1", toolName: "write", args: { content: "x".repeat(5_000) }, parentToolCallId: "p" },
    ]);
    expect((progress as { text: string }).text.length).toBeLessThan(330);
    expect((progress as { text: string }).text.endsWith("…\n")).toBe(true);
  });

  it("carries structured evidence of a tool result when Pi supplies it", () => {
    const mapper = new PiTurnMapper("s");
    const [result] = feed(mapper, [{
      type: "tool_execution_end", toolCallId: "c", toolName: "bash", isError: true, durationMs: 40,
      result: { content: [{ type: "text", text: "tail" }, { type: "image", data: "…", mimeType: "image/png" }], structuredContent: { exit_code: 3, truncated: true } },
    }]);
    expect(result).toEqual({ type: "tool_result", toolUseId: "c", toolName: "bash", output: "tail[image]", isError: true, durationMs: 40, exitCode: 3, truncated: true, sessionId: "s" });
  });

  it("maps a retry that succeeds and one that gives up", () => {
    const mapper = new PiTurnMapper("s");
    const out = feed(mapper, [
      { type: "auto_retry_start", attempt: 2, maxAttempts: 3, delayMs: 4000, errorMessage: "429 rate limit exceeded" },
      { type: "auto_retry_end", success: true, attempt: 2 },
      { type: "auto_retry_start", attempt: 3, maxAttempts: 3, delayMs: 8000, errorMessage: "503 service unavailable" },
      { type: "auto_retry_end", success: false, attempt: 3, finalError: "503 service unavailable" },
    ]);
    expect(out.map(event => (event as { status: string }).status)).toEqual(["waiting", "resumed", "waiting", "failed"]);
    expect(out[0]).toMatchObject({ type: "engine_retry", attempt: 2, delayMs: 4000, reason: "rate-limit" });
    expect(out[1]).toMatchObject({ attempt: 2, delayMs: 0 });
    expect(out[3]).toMatchObject({ attempt: 3, reason: "connection" });
  });

  it("numbers compactions and reports a finished one as completed", () => {
    const mapper = new PiTurnMapper("s");
    const out = feed(mapper, [
      { type: "compaction_start", reason: "threshold" },
      { type: "compaction_end", reason: "threshold", result: { summary: "short" }, aborted: false, willRetry: false },
      { type: "compaction_start", reason: "overflow" },
      { type: "compaction_end", reason: "overflow", aborted: true, willRetry: false },
    ]);
    expect(out.map(event => [(event as { id: string }).id, (event as { status: string }).status])).toEqual([
      ["pi-compaction-1", "started"], ["pi-compaction-1", "completed"], ["pi-compaction-2", "started"], ["pi-compaction-2", "failed"],
    ]);
  });

  it("still reports the end of a compaction whose start it missed", () => {
    const mapper = new PiTurnMapper("s");
    expect(feed(mapper, [{ type: "compaction_end", reason: "manual", result: { summary: "x" }, aborted: false, willRetry: false }]))
      .toEqual([{ type: "context_compaction", id: "pi-compaction-1", status: "completed", sessionId: "s" }]);
  });

  it("forgets a settled state when Pi starts another run", () => {
    const mapper = new PiTurnMapper("s");
    feed(mapper, [{ type: "agent_start" }, { type: "agent_settled", aborted: true }]);
    expect(mapper.settled).toEqual({ aborted: true });
    feed(mapper, [{ type: "agent_start" }]);
    expect(mapper.settled).toBeUndefined();
    expect(mapper.runStarted).toBe(true);
  });
});

describe("Pi usage and text helpers", () => {
  it("sums usage, ignoring values that are not positive finite numbers", () => {
    const usage = { input: 10, output: 5, cacheRead: 3, cacheWrite: 2, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 } };
    const once = addPiUsage(undefined, usage);
    expect(once).toEqual({ inputTokens: 10, outputTokens: 5, cachedTokens: 5, costUsd: 0.5 });
    expect(addPiUsage(once, usage)).toEqual({ inputTokens: 20, outputTokens: 10, cachedTokens: 10, costUsd: 1 });
    expect(addPiUsage(once, undefined)).toBe(once);
    const odd = { input: -4, output: Number.NaN, cacheRead: Number.POSITIVE_INFINITY, cacheWrite: "7", totalTokens: 0 } as unknown as Parameters<typeof addPiUsage>[1];
    expect(addPiUsage(undefined, odd)).toEqual({ inputTokens: 0, outputTokens: 0, cachedTokens: 0 });
    expect("costUsd" in addPiUsage(undefined, odd)!).toBe(false);
  });

  it("reads message text from a string or from text blocks only", () => {
    expect(piMessageText({ role: "user", content: "plain" })).toBe("plain");
    expect(piMessageText({ role: "assistant", content: [{ type: "thinking", thinking: "hidden" }, { type: "text", text: "a" }, { type: "toolCall", id: "c", name: "bash", arguments: {} }, { type: "text", text: "b" }] })).toBe("ab");
    expect(piMessageText({ role: "custom" })).toBe("");
    expect(piMessageText(undefined)).toBe("");
    expect(isPiAssistantMessage({ role: "assistant", content: [] })).toBe(true);
    expect(isPiAssistantMessage({ role: "toolResult", toolCallId: "c", toolName: "x", content: [] })).toBe(false);
    expect(isPiAssistantMessage(undefined)).toBe(false);
  });

  it("renders a tool result as bounded text", () => {
    expect(piToolResultText({ content: [{ type: "text", text: "a" }, { type: "image", data: "x", mimeType: "image/png" }, { type: "other" }, { type: "text", text: "b" }] })).toBe("a[image]b");
    expect(piToolResultText({ content: [{ type: "text", text: "x".repeat(50) }] }, 10)).toBe(`${"x".repeat(10)}\n[output truncated]`);
    expect(piToolResultText("plain string result")).toBe("plain string result");
    expect(piToolResultText({ structuredContent: { output: "only structured" } })).toBe("");
    expect(piToolResultText(undefined)).toBe("");
    expect(piToolResultText(null)).toBe("");
  });
});

describe("buildPiPrompt", () => {
  const PNG_1X1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
  const PNG_SIGNATURE = PNG_1X1.subarray(0, 8);
  const roots: string[] = [];
  afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
  const scratch = async () => { const root = await mkdtemp(path.join(os.tmpdir(), "pi-prompt-")); roots.push(root); return root; };

  it("returns the text unchanged when there are no attachments", async () => {
    expect(await buildPiPrompt({ text: "hello\nworld", files: [], modelAcceptsImages: true })).toEqual({ message: "hello\nworld", images: [], skippedImages: [] });
  });

  it("sends an image as pixels to a vision model and names every attachment by path", async () => {
    const root = await scratch();
    const image = path.join(root, "shot.png"), jpeg = path.join(root, "photo.jpg"), notes = path.join(root, "notes.txt");
    await writeFile(image, PNG_1X1);
    await writeFile(jpeg, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]));
    await writeFile(notes, "just text");
    const prompt = await buildPiPrompt({ text: "look", files: [image, notes, jpeg], modelAcceptsImages: true });
    expect(prompt.message).toBe(`look\nAttachment: ${image}\nAttachment: ${notes}\nAttachment: ${jpeg}`);
    expect(prompt.images).toEqual([
      { type: "image", data: PNG_1X1.toString("base64"), mimeType: "image/png" },
      { type: "image", data: expect.any(String), mimeType: "image/jpeg" },
    ]);
    expect(prompt.skippedImages).toEqual([]);
  });

  it("detects an image by its content, not its name", async () => {
    const root = await scratch();
    const disguised = path.join(root, "report.txt"), fake = path.join(root, "fake.png");
    await writeFile(disguised, PNG_1X1);
    await writeFile(fake, "not really a png");
    const prompt = await buildPiPrompt({ text: "x", files: [disguised, fake], modelAcceptsImages: true });
    expect(prompt.images.map(image => image.mimeType)).toEqual(["image/png"]);
    expect(prompt.skippedImages).toEqual([]);
  });

  it("withholds images from a text-only model and says so, because Pi would drop them silently", async () => {
    const root = await scratch();
    const image = path.join(root, "shot.png"), notes = path.join(root, "notes.txt");
    await writeFile(image, PNG_1X1);
    await writeFile(notes, "just text");
    const prompt = await buildPiPrompt({ text: "look", files: [image, notes], modelAcceptsImages: false });
    expect(prompt.images).toEqual([]);
    expect(prompt.skippedImages).toEqual([{ file: image, reason: "model-has-no-vision" }]);
    expect(prompt.message).toBe(`look\nAttachment: ${image}\nAttachment: ${notes}`);
  });

  it("leaves an image over the inline limit to the agent's own read tool", async () => {
    const root = await scratch();
    const atLimit = path.join(root, "limit.png"), over = path.join(root, "over.png");
    await writeFile(atLimit, Buffer.concat([PNG_SIGNATURE, Buffer.alloc(PI_INLINE_IMAGE_MAX_BYTES - PNG_SIGNATURE.length)]));
    await writeFile(over, Buffer.concat([PNG_SIGNATURE, Buffer.alloc(PI_INLINE_IMAGE_MAX_BYTES - PNG_SIGNATURE.length + 1)]));
    const prompt = await buildPiPrompt({ text: "big", files: [atLimit, over], modelAcceptsImages: true });
    expect(prompt.images).toHaveLength(1);
    expect(Buffer.from(prompt.images[0]!.data, "base64")).toHaveLength(PI_INLINE_IMAGE_MAX_BYTES);
    expect(prompt.skippedImages).toEqual([{ file: over, reason: "too-large" }]);
    expect(prompt.message).toContain(`Attachment: ${over}`);
    expect(PI_INLINE_IMAGE_MAX_BYTES).toBe(3 * 1024 * 1024);
  });

  it("inlines at most eight images per message", async () => {
    const root = await scratch();
    const files: string[] = [];
    for (let index = 0; index < PI_INLINE_IMAGE_MAX_COUNT + 2; index++) { const file = path.join(root, `i${index}.png`); await writeFile(file, PNG_1X1); files.push(file); }
    const prompt = await buildPiPrompt({ text: "many", files, modelAcceptsImages: true });
    expect(PI_INLINE_IMAGE_MAX_COUNT).toBe(8);
    expect(prompt.images).toHaveLength(8);
    expect(prompt.skippedImages).toEqual([{ file: files[8], reason: "too-many" }, { file: files[9], reason: "too-many" }]);
    expect(prompt.message.split("\n").filter(line => line.startsWith("Attachment: "))).toHaveLength(10);
  });

  it("still names a path it cannot open, without failing the turn", async () => {
    const root = await scratch();
    const missing = path.join(root, "gone.png"), folder = path.join(root, "folder");
    await mkdir(folder);
    const prompt = await buildPiPrompt({ text: "x", files: [missing, folder], modelAcceptsImages: true });
    expect(prompt).toEqual({ message: `x\nAttachment: ${missing}\nAttachment: ${folder}`, images: [], skippedImages: [] });
  });
});

describe("extension dialogs as question cards", () => {
  const request = (fields: Record<string, unknown>) => ({ type: "extension_ui_request", id: "d1", ...fields }) as PiExtensionUiRequest;
  const recorded = () => fixtureLines("extension-ui.jsonl").map(line => parsePiFrame(line)).flatMap(frame => (frame.kind === "extension_ui" ? [frame.request] : []));
  const answer = (question: { question: string }, value: unknown) => ({ answers: { [question.question]: value } });

  it("tells dialogs that wait for an answer from fire-and-forget records", () => {
    expect(recorded().map(item => [item.method, isPiDialog(item)])).toEqual([
      ["select", true], ["confirm", true], ["input", true], ["editor", true], ["notify", false], ["setStatus", false], ["setWidget", false],
    ]);
    expect(isPiDialog(request({ method: "setTitle", title: "t" }))).toBe(false);
    expect(isPiDialog(request({ method: "set_editor_text", text: "t" }))).toBe(false);
    for (const item of recorded().filter(item => !isPiDialog(item))) expect(piDialogQuestion(item)).toBeUndefined();
  });

  it("maps the recorded select, confirm, input and editor dialogs", () => {
    const [select, confirm, input, editor] = recorded();
    expect(piDialogQuestion(select!)).toEqual({ question: "Pick one", header: "Extension", options: [{ label: "A" }, { label: "B" }], multiSelect: false, allowFreeText: false });
    // The message is part of the text the card shows; a separate field never reached the owner.
    expect(piDialogQuestion(confirm!)).toEqual({ question: "Sure?\n\nReally?", header: "Extension", options: [{ label: "Yes" }, { label: "No" }], multiSelect: false, allowFreeText: false });
    expect(piDialogQuestion(input!)).toEqual({ question: "Type", header: "Extension", options: [], multiSelect: false, allowFreeText: true, required: false, input: { kind: "text", placeholder: "placeholder" } });
    expect(piDialogQuestion(editor!)).toEqual({ question: "Edit", header: "Extension", options: [], multiSelect: false, allowFreeText: true, required: false, input: { kind: "multiline", prefill: "prefill" } });
  });

  it("localises the header and the confirm choices", () => {
    expect(piDialogQuestion(request({ method: "confirm", title: "继续吗？", message: "" }), "zh")).toEqual({ question: "继续吗？", header: "扩展", options: [{ label: "是" }, { label: "否" }], multiSelect: false, allowFreeText: false });
    expect(piDialogQuestion(request({ method: "select", title: "选一个", options: ["甲"] }), "zh")).toMatchObject({ header: "扩展", options: [{ label: "甲" }] });
    expect(piDialogQuestion(request({ method: "input", title: "t" }))).toEqual({ question: "t", header: "Extension", options: [], multiSelect: false, allowFreeText: true, required: false, input: { kind: "text" } });
    expect(piDialogQuestion(request({ method: "editor", title: "t" }))).toMatchObject({ input: { kind: "multiline" } });
  });

  it("returns the chosen option of a select and cancels on anything else", () => {
    const select = request({ method: "select", title: "Pick one", options: ["A", "B"] });
    const question = piDialogQuestion(select)!;
    expect(piDialogResponse(select, question, answer(question, "B"))).toEqual({ type: "extension_ui_response", id: "d1", value: "B" });
    expect(piDialogResponse(select, question, answer(question, ["A"]))).toEqual({ type: "extension_ui_response", id: "d1", value: "A" });
    for (const foreign of ["C", "a", "", 5, null, [], [7], { label: "A" }]) {
      expect(piDialogResponse(select, question, answer(question, foreign)), JSON.stringify(foreign)).toEqual({ type: "extension_ui_response", id: "d1", cancelled: true });
    }
    for (const missing of [undefined, null, {}, { answers: {} }, { answers: null }, { answers: { "Another question": "A" } }, "A"]) {
      expect(piDialogResponse(select, question, missing), JSON.stringify(missing)).toEqual({ type: "extension_ui_response", id: "d1", cancelled: true });
    }
  });

  it("returns a boolean for a confirm, in the locale the card was shown in", () => {
    const confirm = request({ method: "confirm", title: "Sure?", message: "Really?" });
    for (const [locale, yes, no] of [["en", "Yes", "No"], ["zh", "是", "否"]] as const) {
      const question = piDialogQuestion(confirm, locale)!;
      expect(piDialogResponse(confirm, question, answer(question, yes), locale)).toEqual({ type: "extension_ui_response", id: "d1", confirmed: true });
      expect(piDialogResponse(confirm, question, answer(question, no), locale)).toEqual({ type: "extension_ui_response", id: "d1", confirmed: false });
      expect(piDialogResponse(confirm, question, answer(question, "maybe"), locale)).toEqual({ type: "extension_ui_response", id: "d1", cancelled: true });
    }
    // A card shown in Chinese cannot be answered with the English label.
    const zh = piDialogQuestion(confirm, "zh")!;
    expect(piDialogResponse(confirm, zh, answer(zh, "Yes"), "zh")).toEqual({ type: "extension_ui_response", id: "d1", cancelled: true });
  });

  it("returns free text for input and editor, an empty string included", () => {
    const input = request({ method: "input", title: "Type", placeholder: "p" }), editor = request({ method: "editor", title: "Edit", prefill: "old" });
    const inputQuestion = piDialogQuestion(input)!, editorQuestion = piDialogQuestion(editor)!;
    expect(piDialogResponse(input, inputQuestion, answer(inputQuestion, "typed"))).toEqual({ type: "extension_ui_response", id: "d1", value: "typed" });
    expect(piDialogResponse(editor, editorQuestion, answer(editorQuestion, "  line 1\n\tline 2  \n"))).toEqual({ type: "extension_ui_response", id: "d1", value: "  line 1\n\tline 2  \n" });
    expect(piDialogResponse(editor, editorQuestion, answer(editorQuestion, ""))).toEqual({ type: "extension_ui_response", id: "d1", value: "" });
    expect(piDialogResponse(input, inputQuestion, answer(inputQuestion, ""))).toEqual({ type: "extension_ui_response", id: "d1", value: "" });
    expect(piDialogResponse(editor, editorQuestion, {})).toEqual({ type: "extension_ui_response", id: "d1", cancelled: true });
  });

  it("is not confused by a title that names an Object.prototype member", () => {
    const select = request({ method: "select", title: "constructor", options: ["A"] });
    const question = piDialogQuestion(select)!;
    expect(piDialogResponse(select, question, { answers: {} })).toEqual({ type: "extension_ui_response", id: "d1", cancelled: true });
    expect(piDialogResponse(select, question, answer(question, "A"))).toEqual({ type: "extension_ui_response", id: "d1", value: "A" });
  });
});

describe("session tree projection", () => {
  const recorded = () => (JSON.parse(fixtureLines("session-tree.jsonl")[0]!) as { data: { tree: PiSessionTreeNode[]; leafId: string } }).data;

  it("flattens the recorded two-branch tree, parents before children", () => {
    const { tree, leafId } = recorded();
    const projection = piNativeTree(tree, leafId);
    expect(projection.leafId).toBe("bcd47538");
    expect(projection.nodes).toHaveLength(22);
    const byId = new Map(projection.nodes.map(node => [node.id, node]));
    for (const node of projection.nodes) {
      if (node.parentId === null) continue;
      expect(projection.nodes.indexOf(byId.get(node.parentId)!)).toBeLessThan(projection.nodes.indexOf(node));
      expect(byId.get(node.parentId)!.childIds).toContain(node.id);
    }
    expect(projection.nodes.filter(node => node.parentId === null).map(node => node.id)).toEqual(["3a5e3ad4"]);
    // The branch point, its two children, and the label the navigation attached.
    expect(byId.get("8e2ed43e")).toMatchObject({ type: "message", role: "assistant", preview: "tool result seen by dup-model", childIds: ["df7c0d03", "56246f5a"] });
    expect(byId.get("df7c0d03")).toMatchObject({ type: "message", role: "user", preview: "TOOL again", label: "lab-label" });
    expect(byId.get("56246f5a")).toMatchObject({ type: "label", preview: "", childIds: ["4c511f34"] });
    expect(byId.get("bcd47538")).toMatchObject({ role: "assistant", preview: "Hello from dup-model", childIds: [] });
    expect(projection.nodes.filter(node => node.label).map(node => node.id)).toEqual(["df7c0d03"]);
  });

  it("gives each entry type a short single-line preview and exposes nothing else of it", () => {
    const { tree, leafId } = recorded();
    const byId = new Map(piNativeTree(tree, leafId).nodes.map(node => [node.id, node]));
    expect(byId.get("3a5e3ad4")).toMatchObject({ type: "model_change", preview: "fakeprov/dup-model" });
    expect(byId.get("ba97214c")).toMatchObject({ type: "thinking_level_change", preview: "medium" });
    expect(byId.get("4583c257")).toMatchObject({ role: "system", preview: "[system prompt omitted from fixture]" });
    expect(byId.get("1a315066")).toMatchObject({ role: "toolResult", preview: "tool-ran" });
    expect(byId.get("880261d2")).toMatchObject({ role: "assistant", preview: "" }); // a tool call without text
    for (const node of byId.values()) {
      expect(Object.keys(node).sort().filter(key => !["label", "role", "timestamp"].includes(key))).toEqual(["childIds", "id", "parentId", "preview", "type"]);
      expect(node.preview).not.toMatch(/\n/);
      expect(typeof node.timestamp).toBe("string");
    }
  });

  it("collapses whitespace in a preview and bounds its length", () => {
    const tree: PiSessionTreeNode[] = [{
      entry: { type: "message", id: "a", parentId: null, message: { role: "user", content: `first line\n\n   second\tline ${"x".repeat(400)}` } },
      children: [
        { entry: { type: "branch_summary", id: "b", parentId: "a", summary: "what happened\non the other branch" }, children: [] },
        { entry: { type: "session_info", id: "c", parentId: "a", name: "A name" }, children: [] },
        { entry: { type: "custom", id: "d", parentId: "a", data: { secret: "not shown" } }, children: [] },
      ],
    }];
    const [a, b, c, d] = piNativeTree(tree, "d").nodes;
    expect(a!.preview.startsWith("first line second line xxx")).toBe(true);
    expect(a!.preview).toHaveLength(160);
    expect(a!.preview.endsWith("…")).toBe(true);
    expect(b!.preview).toBe("what happened on the other branch");
    expect(c!.preview).toBe("A name");
    expect(d!.preview).toBe("");
    expect(a!.childIds).toEqual(["b", "c", "d"]);
  });

  it("previews a shell entry as typed and a failed reply by how it ended, as Pi's tree lists both", () => {
    const tree = [{
      entry: { type: "message", id: "s", parentId: null, message: { role: "bashExecution", command: "ls -la", output: "x" } },
      children: [
        { entry: { type: "message", id: "e", parentId: "s", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "429 rate limited" } }, children: [] },
        { entry: { type: "message", id: "t", parentId: "s", message: { role: "assistant", content: [{ type: "toolCall", id: "c", name: "bash", arguments: {} }], stopReason: "toolUse" } }, children: [] },
        { entry: { type: "message", id: "k", parentId: "s", message: { role: "assistant", content: [{ type: "text", text: "kept" }], stopReason: "aborted" } }, children: [] },
      ],
    }];
    const [shell, failed, tools, partial] = piNativeTree(tree as never, null).nodes;
    expect(shell!.preview).toBe("!ls -la");
    expect(failed!.preview).toBe("[error] 429 rate limited");
    // Only tool calls and no failure: no text, so Pi's tree hides it.
    expect(tools!.preview).toBe("");
    // Text wins over the failure note.
    expect(partial!.preview).toBe("kept");
  });

  it("accepts several roots, an empty tree and malformed nodes", () => {
    expect(piNativeTree([], null)).toEqual({ nodes: [], leafId: null });
    const tree = [
      { entry: { type: "message", id: "r1", parentId: null }, children: [] },
      { entry: { type: "message", parentId: null }, children: [{ entry: { type: "message", id: "lost", parentId: "nowhere" }, children: [] }] },
      { entry: { type: "message", id: "r2", parentId: "broken-chain" }, children: [] },
    ] as unknown as PiSessionTreeNode[];
    expect(piNativeTree(tree, "r2").nodes.map(node => [node.id, node.parentId])).toEqual([["r1", null], ["r2", "broken-chain"]]);
  });

  it("returns the text of a user entry, for refilling the composer after navigating to it", () => {
    const { tree } = recorded();
    expect(piUserEntryText(tree, "df7c0d03")).toBe("TOOL again");
    expect(piUserEntryText(tree, "4c511f34")).toBe("branch question");
    expect(piUserEntryText(tree, "8e2ed43e")).toBeUndefined(); // an assistant entry
    expect(piUserEntryText(tree, "56246f5a")).toBeUndefined(); // a label entry
    expect(piUserEntryText(tree, "missing")).toBeUndefined();
    expect(piUserEntryText([], "anything")).toBeUndefined();
  });

  const chain = (depth: number): PiSessionTreeNode[] => {
    let node: PiSessionTreeNode = { entry: { type: "message", id: `n${depth}`, parentId: `n${depth - 1}`, message: { role: "user", content: "deep" } }, children: [] };
    for (let index = depth - 1; index >= 1; index--) node = { entry: { type: "message", id: `n${index}`, parentId: index > 1 ? `n${index - 1}` : null, message: { role: "user", content: "x" } }, children: [node] };
    return [node];
  };

  it("finds user text at the end of a very long session without recursing", () => {
    expect(piUserEntryText(chain(100_000), "n100000")).toBe("deep");
  });

  // DEFECT (reported to the module owner): a session without branches is one chain, so its tree
  // is as deep as the session is long, and the recursive walk overflows the stack (observed
  // from about 8,000 entries). Drop `.fails` once the walk is iterative.
  it("projects a session of 100,000 entries", () => {
    expect(piNativeTree(chain(100_000), "n100000").nodes).toHaveLength(100_000);
  });
});

describe("piUsageCostBreakdown", () => {
  const usage = (total: number, tokens: [number, number, number, number]) => ({ input: tokens[0], output: tokens[1], cacheRead: tokens[2], cacheWrite: tokens[3], totalTokens: tokens.reduce((a, b) => a + b, 0), cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total } });
  const entry = (extra: Record<string, unknown>) => ({ id: `e${Math.random()}`, parentId: null, ...extra }) as never;

  it("groups usage the way Pi's /session does", async () => {
    const { piUsageCostBreakdown } = await import("../src/codex/pi-turn-mapper.js");
    expect(piUsageCostBreakdown([
      entry({ type: "message", message: { role: "user", content: "hi" } }),
      entry({ type: "message", message: { role: "assistant", content: [], provider: "alpha", model: "auto", responseModel: "concrete-model", usage: usage(0.01, [100, 20, 40, 0]) } }),
      entry({ type: "message", message: { role: "assistant", content: [], provider: "alpha", model: "auto", responseModel: "concrete-model", usage: usage(0.02, [10, 10, 0, 5]) } }),
      entry({ type: "message", message: { role: "assistant", content: [], provider: "beta", model: "dup-model", usage: usage(0.5, [1, 1, 0, 0]) } }),
      entry({ type: "usage", provider: "gamma", model: "side-model", usage: usage(0.001, [5, 5, 0, 0]) }),
      entry({ type: "message", message: { role: "toolResult", toolCallId: "t", toolName: "x", content: [], usage: usage(0.002, [3, 0, 0, 0]) } }),
      entry({ type: "compaction", summary: "s", usage: usage(0.003, [7, 0, 0, 0]) }),
      entry({ type: "branch_summary", summary: "s" }),
      // Nothing spent, nothing counted: left out.
      entry({ type: "message", message: { role: "assistant", content: [], provider: "delta", model: "free", usage: usage(0, [0, 0, 0, 0]) } }),
      entry({ type: "message", message: { role: "assistant", content: [], provider: "delta", model: "no-usage" } }),
    ])).toEqual([
      { key: "beta/dup-model", costUsd: 0.5, tokens: 2 },
      // The model that actually answered, not the router name it was asked under.
      { key: "alpha/concrete-model", costUsd: 0.03, tokens: 185 },
      { key: "Tools/summaries", costUsd: 0.005, tokens: 10 },
      { key: "gamma/side-model", costUsd: 0.001, tokens: 10 },
    ]);
    expect(piUsageCostBreakdown([])).toEqual([]);
  });
});
