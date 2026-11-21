import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  PI_TUI_BUILTIN_COMMANDS, PiFrameTooLargeError, PiJsonlDecoder,
  classifyPiError, encodePiRecord, isPiPlaceholderModel, parsePiFrame, parsePiSlashCommand,
  piDisplayText, samePiModel, sanitizePiErrorText, toPiModelRef,
} from "../src/codex/pi-rpc-protocol.js";

const FIXTURE_DIR = fileURLToPath(new URL("./fixtures/pi-rpc/", import.meta.url));
const fixtureFiles = readdirSync(FIXTURE_DIR).filter(name => name.endsWith(".jsonl")).sort();
const fixtureLines = (name: string) => readFileSync(path.join(FIXTURE_DIR, name), "utf8").split("\n").filter(Boolean);
const fixtureRecords = (name: string) => fixtureLines(name).map(line => JSON.parse(line) as Record<string, unknown>);
const allRecords = () => fixtureFiles.flatMap(fixtureRecords);

function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, out);
  else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) { out.push(key); strings(item, out); }
  return out;
}

describe("Pi RPC fixtures recorded from Pi 1.5.2", () => {
  it("has the focused files the other Pi tests rely on", () => {
    expect(fixtureFiles).toEqual(expect.arrayContaining([
      "extension-ui.jsonl", "noauth-responses.jsonl", "run-abort.jsonl", "run-error-retry.jsonl", "run-error.jsonl",
      "run-image.jsonl", "run-steer-followup.jsonl", "run-text.jsonl", "run-thinking.jsonl", "run-tool-aborted.jsonl",
      "run-tool-denied.jsonl", "run-tool.jsonl", "session-commands.jsonl", "session-tree.jsonl",
    ]));
  });

  it.each(fixtureFiles)("classifies every record of %s without rejecting one", name => {
    const lines = fixtureLines(name);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const raw = JSON.parse(line) as { type: string };
      const frame = parsePiFrame(line);
      expect(frame.kind, line.slice(0, 160)).not.toBe("invalid");
      if (raw.type === "response") expect(frame.kind).toBe("response");
      else if (raw.type === "extension_ui_request") expect(frame.kind).toBe("extension_ui");
      else {
        expect(frame.kind).toBe("event");
        // Every event Pi 1.5.2 actually sent is one this build knows by name.
        if (frame.kind === "event") expect(frame.event.type).toBe(raw.type);
      }
    }
  });

  it("covers the event, update, response and dialog kinds listed in the fixtures README", () => {
    const events = new Set<string>(), updates = new Set<string>(), responses = new Set<string>(), dialogs = new Set<string>();
    for (const record of allRecords()) {
      if (record.type === "response") responses.add(`${String(record.command)}:${record.success ? "ok" : "error"}`);
      else if (record.type === "extension_ui_request") dialogs.add(String(record.method));
      else {
        events.add(String(record.type));
        if (record.type === "message_update") updates.add(String((record.assistantMessageEvent as { type: string }).type));
      }
    }
    expect([...events].sort()).toEqual([
      "agent_end", "agent_settled", "agent_start", "auto_retry_end", "auto_retry_start", "bash_execution_update",
      "compaction_end", "compaction_start", "entry_appended", "message_end", "message_start", "message_update",
      "queue_update", "session_info_changed", "thinking_level_changed", "tool_execution_end", "tool_execution_start",
      "tool_execution_update", "turn_end", "turn_start",
    ]);
    expect([...updates].sort()).toEqual([
      "text_delta", "text_end", "text_start", "thinking_delta", "thinking_end", "thinking_start",
      "toolcall_delta", "toolcall_end", "toolcall_start",
    ]);
    expect([...dialogs].sort()).toEqual(["confirm", "editor", "input", "notify", "select", "setStatus", "setWidget"]);
    for (const expected of ["prompt:ok", "prompt:error", "set_model:ok", "set_model:error", "get_state:ok", "get_tree:ok", "fork:ok", "clone:ok", "new_session:ok", "parse:error", "compact:error"]) {
      expect(responses, expected).toContain(expected);
    }
  });

  it("contains only synthetic paths and loopback addresses", () => {
    // Built at run time so this file itself holds no home-directory style literal.
    const forbidden = [["", "Volumes", ""].join("/"), ["", "Users", ""].join("/"), ["", "home", ""].join("/"), ["", "private", ""].join("/")];
    const absolutePath = /(?:^|[\s"'=(:])(\/[A-Za-z0-9._@-]+\/[^\s"']*)/g;
    for (const name of fixtureFiles) {
      for (const text of strings(fixtureRecords(name))) {
        for (const prefix of forbidden) expect(text.includes(prefix), `${name}: ${text.slice(0, 120)}`).toBe(false);
        for (const match of text.matchAll(absolutePath)) expect(match[1]!.startsWith("/synthetic/"), `${name}: ${match[1]}`).toBe(true);
        for (const match of text.matchAll(/https?:\/\/[^\s"'/]+/g)) expect(match[0]).toBe("http://127.0.0.1:1");
      }
    }
  });

  it("keeps the placeholder model and the omitted last-assistant text exactly as Pi sends them", () => {
    const responses = fixtureRecords("noauth-responses.jsonl").filter(record => record.type === "response");
    const state = responses.find(record => record.command === "get_state") as { data: { model: Record<string, unknown> } };
    expect(state.data.model).toMatchObject({ id: "unknown", provider: "unknown", contextWindow: 0 });
    const last = responses.find(record => record.command === "get_last_assistant_text") as { data: Record<string, unknown> };
    expect(last.data).toEqual({});
  });
});

describe("parsePiFrame", () => {
  it("keeps an event type this build does not know, with the raw record", () => {
    const raw = { type: "future_event_from_a_newer_pi", detail: { x: 1 }, list: [1, 2] };
    expect(parsePiFrame(JSON.stringify(raw))).toEqual({ kind: "event", event: { type: "unknown", originalType: "future_event_from_a_newer_pi", raw } });
  });

  it("passes unknown fields of known records through untouched", () => {
    const frame = parsePiFrame(JSON.stringify({ type: "agent_settled", aborted: false, addedLater: "x" }));
    expect(frame).toEqual({ kind: "event", event: { type: "agent_settled", aborted: false, addedLater: "x" } });
    const response = parsePiFrame(JSON.stringify({ type: "response", id: "a", command: "get_state", success: true, data: { model: null }, extra: 1 }));
    expect(response.kind).toBe("response");
  });

  it("accepts the id-less parse error response", () => {
    const frame = parsePiFrame(JSON.stringify({ type: "response", command: "parse", success: false, error: "Failed to parse command: x" }));
    expect(frame).toEqual({ kind: "response", response: { type: "response", command: "parse", success: false, error: "Failed to parse command: x" } });
  });

  it("gives a confirm dialog without a message an empty one", () => {
    const frame = parsePiFrame(JSON.stringify({ type: "extension_ui_request", id: "d1", method: "confirm", title: "Sure?" }));
    expect(frame).toEqual({ kind: "extension_ui", request: { type: "extension_ui_request", id: "d1", method: "confirm", title: "Sure?", message: "" } });
  });

  it("accepts optional dialog fields that are absent or null", () => {
    for (const request of [
      { method: "select", title: "t", options: [], timeout: null },
      { method: "input", title: "t", placeholder: null },
      { method: "editor", title: "t" },
      { method: "setStatus", statusKey: "k" },
      { method: "setWidget", widgetKey: "k", widgetLines: null },
      { method: "setTitle", title: "t" },
      { method: "set_editor_text", text: "" },
      { method: "notify", message: "m" },
    ]) {
      expect(parsePiFrame(JSON.stringify({ type: "extension_ui_request", id: "d", ...request })).kind, request.method).toBe("extension_ui");
    }
  });

  it.each([
    ["not json", "not json", "json"],
    ["truncated json", '{"type":"agent_start"', "json"],
    ["empty string", "", "json"],
    ["a json string", '"agent_start"', "shape"],
    ["a json array", '[{"type":"agent_start"}]', "shape"],
    ["null", "null", "shape"],
    ["a number", "42", "shape"],
    ["no type", '{"command":"x"}', "shape"],
    ["non-string type", '{"type":7}', "shape"],
    ["response without success", '{"type":"response","id":"a","command":"get_state"}', "shape"],
    ["response with a non-boolean success", '{"type":"response","id":"a","command":"get_state","success":"true"}', "shape"],
    ["response without command", '{"type":"response","id":"a","success":true}', "shape"],
    ["response with a numeric id", '{"type":"response","id":3,"command":"get_state","success":true}', "shape"],
    ["response with a non-string error", '{"type":"response","command":"x","success":false,"error":{"m":1}}', "shape"],
    ["dialog without id", '{"type":"extension_ui_request","method":"select","title":"t","options":[]}', "shape"],
    ["dialog with an empty id", '{"type":"extension_ui_request","id":"","method":"select","title":"t","options":[]}', "shape"],
    ["dialog with an unknown method", '{"type":"extension_ui_request","id":"d","method":"custom","title":"t"}', "shape"],
    ["select without options", '{"type":"extension_ui_request","id":"d","method":"select","title":"t"}', "shape"],
    ["select with non-string options", '{"type":"extension_ui_request","id":"d","method":"select","title":"t","options":[1]}', "shape"],
    ["select with a non-numeric timeout", '{"type":"extension_ui_request","id":"d","method":"select","title":"t","options":[],"timeout":"5"}', "shape"],
    ["confirm with a non-string message", '{"type":"extension_ui_request","id":"d","method":"confirm","title":"t","message":5}', "shape"],
    ["input without title", '{"type":"extension_ui_request","id":"d","method":"input"}', "shape"],
    ["notify without message", '{"type":"extension_ui_request","id":"d","method":"notify"}', "shape"],
    ["setWidget with non-string lines", '{"type":"extension_ui_request","id":"d","method":"setWidget","widgetKey":"k","widgetLines":[1]}', "shape"],
    ["message_update without assistantMessageEvent", '{"type":"message_update","usage":{}}', "shape"],
    ["message_update with an untyped assistantMessageEvent", '{"type":"message_update","assistantMessageEvent":{}}', "shape"],
    ["message_start without a message", '{"type":"message_start"}', "shape"],
    ["message_end with a role-less message", '{"type":"message_end","message":{"content":"x"}}', "shape"],
    ["agent_end without willRetry", '{"type":"agent_end","messages":[]}', "shape"],
    ["agent_settled without aborted", '{"type":"agent_settled"}', "shape"],
    ["turn_end without toolResults", '{"type":"turn_end","message":{"role":"assistant","content":[]}}', "shape"],
    ["tool_execution_start without a tool name", '{"type":"tool_execution_start","toolCallId":"c"}', "shape"],
    ["tool_execution_end without isError", '{"type":"tool_execution_end","toolCallId":"c","toolName":"bash","result":{}}', "shape"],
    ["queue_update with non-string entries", '{"type":"queue_update","steering":[1],"followUp":[]}', "shape"],
    ["thinking_level_changed without level", '{"type":"thinking_level_changed"}', "shape"],
    ["compaction_end without aborted", '{"type":"compaction_end","reason":"manual","willRetry":false}', "shape"],
    ["auto_retry_start with a non-finite delay", '{"type":"auto_retry_start","attempt":1,"maxAttempts":3,"delayMs":null,"errorMessage":"x"}', "shape"],
    ["auto_retry_end without attempt", '{"type":"auto_retry_end","success":true}', "shape"],
    ["bash_execution_update without delta", '{"type":"bash_execution_update","id":"a"}', "shape"],
    ["extension_error without path", '{"type":"extension_error","event":"tool_call","error":"x"}', "shape"],
    ["entry_appended with an untyped entry", '{"type":"entry_appended","entry":{}}', "shape"],
  ])("rejects %s", (_label, line, reason) => {
    expect(parsePiFrame(line)).toEqual({ kind: "invalid", reason });
  });

  it("never throws on arbitrary well-formed JSON", () => {
    for (const line of ["{}", "[]", "true", '{"type":""}', '{"type":"response"}', '{"type":"extension_ui_request"}', '{"type":"message_update","assistantMessageEvent":null}', '{"type":" agent_start"}']) {
      expect(() => parsePiFrame(line), line).not.toThrow();
    }
  });

  // DEFECT (reported to the module owner): event types are looked up on a plain object, so
  // names inherited from Object.prototype are not treated as unknown event types. Once the
  // lookup uses own keys only, drop `.fails` from the two tests below.
  it("treats event types named like Object.prototype members as unknown, without throwing", () => {
    for (const type of ["__proto__", "hasOwnProperty", "valueOf"]) {
      const frame = parsePiFrame(JSON.stringify({ type }));
      expect(frame.kind).toBe("event");
    }
  });
  it("does not mistake `constructor` or `toString` for a known event", () => {
    for (const type of ["constructor", "toString"]) {
      const frame = parsePiFrame(JSON.stringify({ type }));
      expect(frame).toEqual({ kind: "event", event: { type: "unknown", originalType: type, raw: { type } } });
    }
  });
});

describe("PiJsonlDecoder", () => {
  it("enforces the UTF-8 byte limit for fragmented Unicode records", () => {
    const exact = new PiJsonlDecoder(7);
    expect(exact.push(Buffer.from("汉🙂\n"))).toEqual(["汉🙂"]);
    const tooLarge = new PiJsonlDecoder(6);
    const bytes = Buffer.from("汉🙂");
    expect(tooLarge.push(bytes.subarray(0, 5))).toEqual([]);
    expect(() => tooLarge.push(bytes.subarray(5))).toThrow(PiFrameTooLargeError);
    expect(() => new PiJsonlDecoder(6).push("汉🙂\n")).toThrow(PiFrameTooLargeError);
  });

  it("counts an emoji split between string chunks as one UTF-8 character", () => {
    const decoder = new PiJsonlDecoder(4);
    expect(decoder.push("\ud83d")).toEqual([]);
    expect(decoder.push("\ude42\n")).toEqual(["🙂"]);
  });

  it("checks incomplete UTF-8 flushed at EOF and releases rejected fragments", () => {
    const decoder = new PiJsonlDecoder(2);
    expect(decoder.push(Buffer.from([0xe6, 0xb1]))).toEqual([]);
    expect(() => decoder.end()).toThrow(PiFrameTooLargeError);
    expect(decoder.end()).toEqual([]);
    expect(decoder.push("a\n")).toEqual(["a"]);
  });

  it("reassembles a large fragmented transcript and resets the limit for each record", () => {
    const frame = JSON.stringify({ text: "汉🙂".repeat(100_000) });
    const bytes = Buffer.from(frame + "\r\n" + frame + "\n");
    const decoder = new PiJsonlDecoder(Buffer.byteLength(frame) + 1);
    const records: string[] = [];
    for (let i = 0; i < bytes.length; i += 4096) records.push(...decoder.push(bytes.subarray(i, i + 4096)));
    expect(records).toEqual([frame, frame]);
    expect(decoder.end()).toEqual([]);
  });

  it("splits on LF only and strips a trailing CR", () => {
    const decoder = new PiJsonlDecoder();
    expect(decoder.push('{"a":1}\n{"b":2}\r\n{"c"')).toEqual(['{"a":1}', '{"b":2}']);
    expect(decoder.push(":3}\n")).toEqual(['{"c":3}']);
    expect(decoder.end()).toEqual([]);
  });

  it("does not split on U+2028, U+2029, NEL, VT or FF inside a record", () => {
    const record = { type: "message_update", text: "line\u2028separator\u2029paragraph\u0085nel\u000bvt\u000cff" };
    const line = encodePiRecord(record);
    expect(line.endsWith("\n")).toBe(true);
    expect(line.includes("\u2028")).toBe(true); // JSON.stringify leaves them raw, as Pi's own serializer does
    const decoder = new PiJsonlDecoder();
    const lines = decoder.push(Buffer.from(line, "utf8"));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual(record);
  });

  it("reassembles a multi-byte character split across chunks", () => {
    const bytes = Buffer.from('{"text":"汉字🙂é"}\n', "utf8");
    for (let cut = 1; cut < bytes.length; cut++) {
      const decoder = new PiJsonlDecoder();
      const lines = [...decoder.push(bytes.subarray(0, cut)), ...decoder.push(bytes.subarray(cut))];
      expect(lines, `cut at ${cut}`).toEqual(['{"text":"汉字🙂é"}']);
    }
  });

  it("accepts byte and string chunks in any mix, one byte at a time", () => {
    const decoder = new PiJsonlDecoder();
    const out: string[] = [];
    for (const byte of Buffer.from('{"a":"ü"}\n{"b":2}\n', "utf8")) out.push(...decoder.push(Buffer.from([byte])));
    out.push(...decoder.push('{"c":3}\n'));
    expect(out).toEqual(['{"a":"ü"}', '{"b":2}', '{"c":3}']);
  });

  it("skips empty lines", () => {
    expect(new PiJsonlDecoder().push('\n\n{"a":1}\n\n{"b":2}\n\n')).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("flushes an unterminated final record at end of stream, once", () => {
    const decoder = new PiJsonlDecoder();
    expect(decoder.push('{"a":1}\n{"type":"agent_settled","aborted":false}\r')).toEqual(['{"a":1}']);
    expect(decoder.end()).toEqual(['{"type":"agent_settled","aborted":false}']);
    expect(decoder.end()).toEqual([]);
  });

  it("rejects a record larger than the limit, terminated or not", () => {
    const terminated = new PiJsonlDecoder(16);
    expect(terminated.push(`${"x".repeat(16)}\n`)).toEqual(["x".repeat(16)]);
    expect(() => terminated.push(`${"x".repeat(17)}\n`)).toThrow(PiFrameTooLargeError);
    const open = new PiJsonlDecoder(16);
    expect(open.push("x".repeat(16))).toEqual([]);
    let error: unknown;
    try { open.push("x"); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(PiFrameTooLargeError);
    expect((error as PiFrameTooLargeError).limitBytes).toBe(16);
    expect((error as Error).name).toBe("PiFrameTooLargeError");
  });
});

it("keeps extension content and multiline/emoji text while removing terminal presentation", () => {
  const content = "C:\\Projects\\notes.txt\n\t中文 👩‍💻 api_key=synthetic_display_value";
  expect(piDisplayText(`\x1b[31m${content}\x1b[0m`)).toBe(content);
});

describe("sanitizePiErrorText", () => {
  it("removes residual control and directional formatting characters", () => {
    expect(sanitizePiErrorText("ready\x00\x07\x7f\u202e\u2066 end\u2069")).toBe("ready end");
  });
  it("removes terminal escapes and masks common credentials before showing diagnostics", () => {
    const input = '\x1b[31mResource failed\x1b[0m api_key=synthetic-private-value Authorization: Bearer synthetic-bearer-value\nHint: Start without extensions using "pi -ne".';
    const result = sanitizePiErrorText(input);
    expect(result).toContain("Resource failed");
    expect(result).toContain("[redacted]");
    expect(result).not.toMatch(/\x1b|synthetic-private-value|synthetic-bearer-value|pi -ne/);
    expect(sanitizePiErrorText('\x1b]8;;https://example.com\x07visible\x1b]8;;\x07')).toBe("visible");
  });

  it("keeps the meaning of Pi's no-model error and drops its docs references and terminal advice", () => {
    const record = fixtureRecords("noauth-responses.jsonl").find(item => item.command === "prompt" && item.success === false) as { error: string };
    expect(record.error).toContain("/synthetic/lab/node_modules/");
    expect(sanitizePiErrorText(record.error)).toBe("No API key found for the selected model.");
  });

  it.each([
    ["a quoted path with spaces", "ENOENT: no such file or directory, open '/synthetic/data/My Folder/secret plan.html'", "ENOENT: no such file or directory, open '…/secret plan.html'"],
    ["a double-quoted path", 'cannot read "/synthetic/data/dir one/file.txt" now', 'cannot read "…/file.txt" now'],
    ["a backtick path", "see `/synthetic/data/dir/file.txt`", "see `…/file.txt`"],
    ["a bare path mid-sentence", "Session found in different project: /synthetic/data/proj\nFork this session into current directory? [y/N] Aborted.", "Session found in different project: …/proj Fork this session into current directory? [y/N] Aborted."],
    ["a Windows drive path", "Failed at C:\\synthetic\\repo\\file.ts", "Failed at …/file.ts"],
    ["a Windows drive path with forward slashes", "Failed at C:/synthetic/repo/file.ts", "Failed at …/file.ts"],
    ["a UNC path", "open \\\\server\\share\\folder\\x.txt failed", "open …/x.txt failed"],
    ["a path with a line and column", "at /synthetic/app/src/main.ts:12:3", "at …/main.ts:12:3"],
    ["a path in parentheses", "failed (/synthetic/app/src/main.ts)", "failed (…/main.ts)"],
    ["an assignment", "cwd=/synthetic/app/src", "cwd=…/src"],
    ["a trailing separator", "error in /synthetic/app/src/ today", "error in …/src today"],
    ["several paths on one line", "copy /synthetic/a/b to /synthetic/c/d", "copy …/b to …/d"],
  ])("reduces %s to its last segment", (_label, input, expected) => {
    const output = sanitizePiErrorText(input);
    expect(output).toBe(expected);
    expect(output).not.toContain("synthetic");
  });

  it.each([
    ["a URL", "see https://example.test/a/b/c and http://127.0.0.1:1/v1/chat"],
    ["a ratio and and/or", "ratio 3/4 and and/or stay"],
    ["a provider/model reference", "Model not found: anthropic/claude-sonnet-4-5"],
    ["a relative repository name", "clone org/repo failed"],
    ["a single slash command", "Unknown command /settings"],
    ["JSON from a provider", '401: {"message":"fake invalid api key"}'],
    ["a quoted slash command", "type '/model x' to switch"],
  ])("leaves %s untouched", (_label, input) => {
    expect(sanitizePiErrorText(input)).toBe(input);
  });

  it("removes the terminal-only login advice", () => {
    expect(sanitizePiErrorText("Authentication failed for \"anthropic\". Credentials may have expired or network is unavailable. Run '/login anthropic' to re-authenticate."))
      .toBe("Authentication failed for \"anthropic\". Credentials may have expired or network is unavailable.");
    expect(sanitizePiErrorText("No models available.\nUse /login to sign in.\nSee:\n/synthetic/docs/providers.md")).toBe("No models available.");
    expect(sanitizePiErrorText("Run '/login' first")).toBe("");
  });

  it("drops lines that are only a path and collapses whitespace", () => {
    expect(sanitizePiErrorText("first\r\n\r\n   /synthetic/pkg/docs/models.md   \n second\tline ")).toBe("first second line");
    expect(sanitizePiErrorText("/synthetic/pkg/docs/models.md")).toBe("");
  });

  it("bounds the length and tolerates missing input", () => {
    const long = sanitizePiErrorText("word ".repeat(400), 50);
    expect(long).toHaveLength(50);
    expect(long.endsWith("…")).toBe(true);
    expect(sanitizePiErrorText("short", 50)).toBe("short");
    expect(sanitizePiErrorText(undefined as unknown as string)).toBe("");
    expect(sanitizePiErrorText(null as unknown as string)).toBe("");
    expect(sanitizePiErrorText(404 as unknown as string)).toBe("404");
  });

  // DEFECTS (reported to the module owner): directory names survive in these shapes. Each test
  // states the property that should hold; drop `.fails` as each shape is handled.
  it("does not leak directory names of an unquoted path that contains spaces", () => {
    const output = sanitizePiErrorText("open /synthetic/accounts/First Last/Documents/secret plan.txt failed");
    expect(output).not.toContain("Last");
    expect(output).not.toContain("Documents");
  });
  it("reduces an unquoted Windows path whose first folder contains a space", () => {
    const output = sanitizePiErrorText("cannot start C:\\Program Files\\Some Tool\\bin\\tool.exe now");
    expect(output).not.toContain("Some Tool");
    expect(output).not.toContain("Program Files");
  });
  it("reduces a file URL", () => {
    expect(sanitizePiErrorText("see file:///synthetic/accounts/someone/project/notes.md")).not.toContain("someone");
  });
  it("reduces a relative path that climbs out with ../", () => {
    expect(sanitizePiErrorText("ENOENT ../../synthetic/accounts/someone/.config/app.json")).not.toContain("someone");
  });
});

describe("classifyPiError", () => {
  const nativeErrors = () => allRecords().filter(record => record.type === "response" && record.success === false).map(record => String(record.error));

  it("classifies the errors Pi 1.5.2 actually returned", () => {
    const kinds = Object.fromEntries(nativeErrors().map(error => [error.split("\n")[0]!, classifyPiError(error)]));
    expect(kinds).toEqual({
      "Model not found: nope/nope": "model-unavailable",
      "Model not found: anthropic/claude-sonnet-4-5": "model-unavailable",
      "No API key found for the selected model.": "no-model",
      "Unknown command: definitely_not_a_command": "other",
      "Failed to parse command: Expected property name or '}' in JSON at position 1 (line 1 column 2)": "other",
      "Session name cannot be empty": "other",
      "Nothing to compact (session too small)": "other",
      "Cannot export in-memory session to HTML": "other",
      "Invalid entry ID for forking": "other",
      "This session has not been saved yet. Send a message before cloning or forking it.": "other",
      "Entry not found: nope": "other",
      "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.": "busy",
    });
  });

  it("classifies the remaining native texts read from the 1.5.2 source", () => {
    expect(classifyPiError("Authentication failed for \"anthropic\". Credentials may have expired or network is unavailable. Run '/login anthropic' to re-authenticate.")).toBe("auth");
    expect(classifyPiError("Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.")).toBe("compacting");
    expect(classifyPiError("No models available. Use /login")).toBe("no-model");
    expect(classifyPiError("No model selected.")).toBe("no-model");
    expect(classifyPiError("401: {\"message\":\"fake invalid api key\"}")).toBe("other");
    expect(classifyPiError("")).toBe("other");
  });
});

describe("Pi model helpers", () => {
  it("recognises the placeholder Pi reports when no model is usable", () => {
    const state = fixtureRecords("noauth-responses.jsonl").find(record => record.command === "get_state") as { data: { model: unknown } };
    expect(isPiPlaceholderModel(state.data.model)).toBe(true);
    expect(toPiModelRef(state.data.model)).toBeUndefined();
    for (const model of [undefined, null, "x", [], {}, { provider: "p" }, { id: "m" }, { provider: "", id: "m" }, { provider: "p", id: "" }, { provider: 1, id: "m" }]) {
      expect(isPiPlaceholderModel(model), JSON.stringify(model)).toBe(true);
    }
  });

  it("accepts a real model, including ids and providers that only look like the placeholder", () => {
    const state = fixtureRecords("session-commands.jsonl").find(record => record.command === "get_state") as { data: { model: Record<string, unknown> } };
    expect(isPiPlaceholderModel(state.data.model)).toBe(false);
    expect(toPiModelRef(state.data.model)).toEqual({ provider: state.data.model.provider, modelId: state.data.model.id });
    expect(toPiModelRef({ provider: "unknown", id: "real-model" })).toEqual({ provider: "unknown", modelId: "real-model" });
    expect(toPiModelRef({ provider: "openrouter", id: "vendor/model:free" })).toEqual({ provider: "openrouter", modelId: "vendor/model:free" });
  });

  it("compares model references by provider and id, case-sensitively", () => {
    const a = { provider: "fakeprov", modelId: "dup-model" };
    expect(samePiModel(a, { ...a })).toBe(true);
    expect(samePiModel(a, { provider: "fakeprov2", modelId: "dup-model" })).toBe(false);
    expect(samePiModel(a, { provider: "fakeprov", modelId: "Dup-Model" })).toBe(false);
    expect(samePiModel(a, undefined)).toBe(false);
    expect(samePiModel(undefined, undefined)).toBe(false);
  });
});

describe("parsePiSlashCommand", () => {
  it.each([
    ["/a b", { name: "a", args: "b" }],
    ["/a", { name: "a", args: "" }],
    ["/skill:x y z", { name: "skill:x", args: "y z" }],
    ["/a  b  ", { name: "a", args: "b" }],
    ["/a b/c", { name: "a", args: "b/c" }],
    ["/model fakeprov/dup-model", { name: "model", args: "fakeprov/dup-model" }],
    ["/scoped-models", { name: "scoped-models", args: "" }],
  ])("parses %j", (text, expected) => {
    expect(parsePiSlashCommand(text)).toEqual(expected);
  });

  // Pi ends the name at the first U+0020 only (agent-session.ts:2270), so a tab or line break inside it makes the text prose.
  it.each(["//x", "/", "/ a", "/a/b", "/synthetic/dir/file.txt", "/a\\b", " /a", "a /b", "", "!cmd", "hello", "/a\tb", "/model\nfoo"])("does not treat %j as a command", text => {
    expect(parsePiSlashCommand(text)).toBeUndefined();
  });
});

describe("PI_TUI_BUILTIN_COMMANDS", () => {
  // Pi 1.5.2: the 24 names of BUILTIN_SLASH_COMMANDS (core/slash-commands.ts) plus the three
  // the terminal UI dispatches without listing (/debug, /arminsayshi, /dementedelves).
  const registry = [
    "settings", "model", "tree", "thinking", "scoped-models", "export", "import", "share", "bug", "copy", "name", "session",
    "changelog", "hotkeys", "fork", "clone", "trust", "login", "logout", "new", "compact", "resume", "reload", "quit",
  ];
  const hidden = ["debug", "arminsayshi", "dementedelves"];

  it("lists exactly the 27 terminal built-ins of Pi 1.5.2", () => {
    expect(registry).toHaveLength(24);
    expect(Object.keys(PI_TUI_BUILTIN_COMMANDS).sort()).toEqual([...registry, ...hidden].sort());
  });

  it("routes each one and cannot be altered", () => {
    for (const [name, route] of Object.entries(PI_TUI_BUILTIN_COMMANDS)) expect(["rpc", "bridge", "host", "terminal"], name).toContain(route);
    expect(PI_TUI_BUILTIN_COMMANDS.tree).toBe("bridge");
    expect(PI_TUI_BUILTIN_COMMANDS.reload).toBe("bridge");
    expect(PI_TUI_BUILTIN_COMMANDS.login).toBe("terminal");
    expect(PI_TUI_BUILTIN_COMMANDS.share).toBe("terminal");
    expect(Object.isFrozen(PI_TUI_BUILTIN_COMMANDS)).toBe(true);
    // Session commands of the built-in extensions are not terminal built-ins.
    expect("mcp" in PI_TUI_BUILTIN_COMMANDS).toBe(false);
    expect("llama" in PI_TUI_BUILTIN_COMMANDS).toBe(false);
  });
});
