import { EventEmitter } from "node:events";
import { closeSync, openSync, readSync } from "node:fs";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { PiSpawn } from "../../src/codex/pi-rpc-client.js";

/**
 * In-process stand-in for `pi --mode rpc`, shaped after frames recorded from
 * Pi 1.5.2. It answers the commands the adapter uses and lets a test script a
 * run. Behaviours copied from the real process are marked "observed".
 */

export interface FakePiModel {
  id: string; name: string; provider: string; api: string; baseUrl: string;
  reasoning: boolean; input: string[]; contextWindow: number; maxTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export const fakePiModel = (provider: string, id: string, extra: Partial<FakePiModel> = {}): FakePiModel => ({
  id, name: id, provider, api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1",
  reasoning: true, input: ["text", "image"], contextWindow: 32000, maxTokens: 4096,
  cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 }, ...extra,
});

/** Observed: with no usable model Pi reports this object instead of omitting `model`. */
export const FAKE_PI_PLACEHOLDER_MODEL = {
  id: "unknown", name: "unknown", api: "unknown", provider: "unknown", baseUrl: "", reasoning: false, input: [],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 0, maxTokens: 0,
};

type Command = { id?: string; type: string; [key: string]: unknown };
export interface FakePiRun {
  /** Emit a session event record. */
  emit(event: Record<string, unknown>): void;
  /** Emit a complete assistant reply (message_start, deltas, message_end) for `text`. */
  reply(text: string, extra?: { stopReason?: string; errorMessage?: string; thinking?: string }): void;
  /** Emit a tool call with its execution and result, as one turn. */
  tool(call: { id: string; name: string; args: Record<string, unknown>; output?: string; isError?: boolean; parentToolCallId?: string }): void;
  /** agent_end + agent_settled. */
  finish(options?: { aborted?: boolean }): void;
  readonly command: Command;
  readonly process: FakePiProcess;
}

/** Observed: Pi takes a session's id from the header line of the file it opens, whatever the file is called. */
function sessionHeaderId(file: string | undefined): string | undefined {
  if (!file) return;
  let handle: number | undefined;
  try {
    handle = openSync(file, "r");
    const buffer = Buffer.alloc(64 * 1024);
    const text = buffer.subarray(0, readSync(handle, buffer, 0, buffer.length, 0)).toString("utf8");
    const header = JSON.parse(text.split("\n", 1)[0]!) as { type?: unknown; id?: unknown };
    return header.type === "session" && typeof header.id === "string" && header.id ? header.id : undefined;
  } catch { return; } finally { if (handle !== undefined) closeSync(handle); }
}

export interface FakePiOptions {
  models?: FakePiModel[];
  /** Initial model; undefined with no models means "no usable model". */
  model?: FakePiModel;
  sessionId?: string;
  sessionFile?: string;
  thinkingLevel?: string;
  /** Called for each `prompt` that starts a run. Default: reply "ok" and finish. */
  onPrompt?: (run: FakePiRun) => void | Promise<void>;
  /** Intercept any command before the default handling; return true when handled. */
  onCommand?: (command: Command, process: FakePiProcess) => boolean | void;
  /** Do not answer anything (startup timeout). */
  silent?: boolean;
  /** Exit immediately with this code and stderr, before reading a command. */
  exitAtStart?: { code: number; stderr?: string };
  commands?: Array<{ name: string; description?: string; source: string }>;
  /** Answer `switch_session` as cancelled (an extension vetoed it). */
  cancelSwitch?: boolean;
}

export class FakePiProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  readonly pid = 4242;
  readonly received: Command[] = [];
  readonly uiResponses: Array<Record<string, unknown>> = [];
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  killSignals: Array<NodeJS.Signals | number | undefined> = [];
  /** When true, SIGTERM and stdin EOF are ignored (forces escalation to a tree kill). */
  stubborn = false;

  models: FakePiModel[];
  state: Record<string, unknown>;
  queue = { steering: [] as string[], followUp: [] as string[] };
  entries: Array<Record<string, unknown>> = [];
  messages: Array<Record<string, unknown>> = [];
  activeRun: FakePiRun | undefined;
  private buffer = "";
  private entrySequence = 0;
  private ended = false;

  constructor(readonly spawnArgs: { command: string; args: string[]; options: SpawnOptions }, readonly options: FakePiOptions = {}) {
    super();
    this.models = options.models ?? [fakePiModel("fakeprov", "dup-model"), fakePiModel("fakeprov", "plain-model", { reasoning: false, input: ["text"] }), fakePiModel("fakeprov2", "dup-model")];
    const sessionIdArg = spawnArgs.args[spawnArgs.args.indexOf("--session-id") + 1];
    const sessionPath = spawnArgs.args.includes("--session") ? spawnArgs.args[spawnArgs.args.indexOf("--session") + 1] : undefined;
    // Pi names session files `<timestamp>_<id>.jsonl`; a file that exists is identified by its header.
    const resumedId = sessionHeaderId(sessionPath) ?? sessionPath?.match(/_([^_/\\]+)\.jsonl$/)?.[1];
    const sessionId = options.sessionId ?? resumedId ?? (spawnArgs.args.includes("--session-id") ? sessionIdArg : "fake-session-1");
    const model = options.model ?? this.models[0];
    this.state = {
      model: model ?? FAKE_PI_PLACEHOLDER_MODEL, thinkingLevel: options.thinkingLevel ?? (model?.reasoning ? "medium" : "off"),
      isStreaming: false, isCompacting: false, steeringMode: "one-at-a-time", followUpMode: "one-at-a-time",
      ...(spawnArgs.args.includes("--no-session") ? {} : { sessionFile: options.sessionFile ?? sessionPath ?? `/synthetic/sessions/2026-01-01T00-00-00-000Z_${sessionId}.jsonl` }),
      sessionId, autoCompactionEnabled: true, messageCount: 0, pendingMessageCount: 0,
    };
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => { this.receive(chunk.toString("utf8")); callback(); },
      final: callback => { callback(); if (!this.stubborn) this.exit(0); },
    });
    if (options.exitAtStart) {
      const { code, stderr } = options.exitAtStart;
      queueMicrotask(() => { if (stderr) this.stderr.write(stderr); this.exit(code); });
    }
  }

  get sessionId(): string { return this.state.sessionId as string; }
  get args(): string[] { return this.spawnArgs.args; }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killSignals.push(signal);
    this.killed = true;
    if (this.stubborn && signal !== "SIGKILL") return true;
    this.exit(signal === "SIGTERM" || signal === undefined ? 143 : null, signal === "SIGKILL" ? "SIGKILL" : null);
    return true;
  }

  /** End the process: streams close, then `exit` and `close` fire. */
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.ended) return;
    this.ended = true;
    this.exitCode = code; this.signalCode = signal;
    this.stdout.end(); this.stderr.end();
    setImmediate(() => { this.emit("exit", code, signal); this.emit("close", code, signal); });
  }

  /** Write one stdout record. */
  send(record: Record<string, unknown>): void {
    if (!this.ended) this.stdout.write(`${JSON.stringify(record)}\n`);
  }
  sendRaw(text: string): void { if (!this.ended) this.stdout.write(text); }

  respond(command: Command, data?: unknown): void {
    this.send({ id: command.id, type: "response", command: command.type, success: true, ...(data === undefined ? {} : { data }) });
  }
  fail(command: Command, error: string): void {
    this.send({ id: command.id, type: "response", command: command.type, success: false, error });
  }

  /** Ask the client for an extension dialog or send a fire-and-forget UI record. */
  ui(request: Record<string, unknown>): void {
    this.send({ type: "extension_ui_request", ...request });
  }

  appendEntry(entry: Record<string, unknown>): Record<string, unknown> {
    const previous = this.entries[this.entries.length - 1];
    const full = { id: `e${++this.entrySequence}`, parentId: previous ? previous.id : null, timestamp: "2026-01-01T00:00:00.000Z", ...entry };
    this.entries.push(full);
    return full;
  }

  private receive(text: string): void {
    this.buffer += text;
    for (let end = this.buffer.indexOf("\n"); end >= 0; end = this.buffer.indexOf("\n")) {
      const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
      if (!line.trim()) continue;
      let command: Command;
      try { command = JSON.parse(line) as Command; } catch { this.send({ type: "response", command: "parse", success: false, error: "Failed to parse command: bad json" }); continue; }
      if (command.type === "extension_ui_response") { this.uiResponses.push(command); this.emit("ui-response", command); continue; }
      this.received.push(command);
      if (this.options.silent) continue;
      if (this.options.onCommand?.(command, this) === true) continue;
      this.handle(command);
    }
  }

  private currentModel(): FakePiModel | undefined {
    const model = this.state.model as FakePiModel;
    return model.provider === "unknown" ? undefined : model;
  }

  private levels(): string[] {
    return this.currentModel()?.reasoning ? ["off", "minimal", "low", "medium", "high"] : ["off"];
  }

  private startRun(command: Command): void {
    const process = this;
    this.state.isStreaming = true;
    const userText = String(command.message ?? "");
    this.messages.push({ role: "user", content: userText });
    this.appendEntry({ type: "message", message: { role: "user", content: userText } });
    this.send({ type: "agent_start" });
    this.send({ type: "turn_start" });
    this.send({ type: "message_start", message: { role: "user", content: userText } });
    this.send({ type: "message_end", message: { role: "user", content: userText } });
    const run: FakePiRun = {
      command, process,
      emit: event => process.send(event),
      reply(text, extra = {}) {
        const model = process.currentModel();
        const usage = { input: 80, output: 20, cacheRead: 40, cacheWrite: 0, totalTokens: 140, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 } };
        const stopReason = extra.stopReason ?? "stop";
        const message = { role: "assistant", content: text ? [{ type: "text", text }] : [], provider: model?.provider, model: model?.id, usage, stopReason, ...(extra.errorMessage ? { errorMessage: extra.errorMessage } : {}), thinkingLevel: process.state.thinkingLevel };
        process.send({ type: "message_start", message: { role: "assistant", content: [], stopReason: stopReason === "error" ? "error" : "pending" } });
        if (extra.thinking) {
          process.send({ type: "message_update", usage, assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } });
          process.send({ type: "message_update", usage, assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: extra.thinking } });
          process.send({ type: "message_update", usage, assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: extra.thinking } });
        }
        if (text && stopReason !== "error") {
          const half = Math.max(1, Math.floor(text.length / 2));
          process.send({ type: "message_update", usage, assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
          process.send({ type: "message_update", usage, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text.slice(0, half) } });
          if (text.length > half) process.send({ type: "message_update", usage, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text.slice(half) } });
          process.send({ type: "message_update", usage, assistantMessageEvent: { type: "text_end", contentIndex: 0, content: text } });
        }
        process.send({ type: "message_end", message });
        process.messages.push(message);
        process.appendEntry({ type: "message", message });
        process.send({ type: "turn_end", message, toolResults: [] });
      },
      tool(call) {
        const parent = call.parentToolCallId ? { parentToolCallId: call.parentToolCallId } : {};
        const result = { content: [{ type: "text", text: call.output ?? "done\n" }], ...(call.name === "bash" ? { structuredContent: { output: call.output ?? "done\n", truncated: false, exit_code: call.isError ? 1 : 0 } } : {}) };
        process.send({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.args, ...parent });
        process.send({ type: "tool_execution_end", toolCallId: call.id, toolName: call.name, result, isError: Boolean(call.isError), durationMs: 5, ...parent });
      },
      finish(options = {}) {
        if (process.activeRun !== run) return;
        process.activeRun = undefined;
        process.state.isStreaming = false;
        process.send({ type: "agent_end", messages: [], willRetry: false });
        process.send({ type: "agent_settled", aborted: Boolean(options.aborted) });
      },
    };
    this.activeRun = run;
    void Promise.resolve().then(() => (this.options.onPrompt ?? (r => { r.reply("ok"); r.finish(); }))(run)).catch(() => {});
  }

  private handle(command: Command): void {
    switch (command.type) {
      case "get_state": this.respond(command, { ...this.state, messageCount: this.messages.length, pendingMessageCount: this.queue.steering.length + this.queue.followUp.length }); return;
      case "get_available_models": this.respond(command, { models: this.models }); return;
      case "get_available_thinking_levels": this.respond(command, { levels: this.levels() }); return;
      case "set_model": {
        const model = this.models.find(candidate => candidate.provider === command.provider && candidate.id === command.modelId);
        // Observed: an unknown model and a provider without credentials share this text.
        if (!model) { this.fail(command, `Model not found: ${String(command.provider)}/${String(command.modelId)}`); return; }
        this.state.model = model;
        this.appendEntry({ type: "model_change", provider: model.provider, modelId: model.id });
        if (!this.levels().includes(this.state.thinkingLevel as string)) { this.state.thinkingLevel = "off"; this.send({ type: "thinking_level_changed", level: "off" }); }
        this.respond(command, model); return;
      }
      case "set_thinking_level": {
        // Observed: an unsupported level is clamped silently and still answers success.
        const levels = this.levels(), requested = String(command.level);
        const next = levels.includes(requested) ? requested : levels[levels.length - 1]!;
        if (next !== this.state.thinkingLevel) { this.state.thinkingLevel = next; this.send({ type: "thinking_level_changed", level: next }); }
        this.respond(command); return;
      }
      case "prompt": {
        const text = String(command.message ?? "");
        if (!this.currentModel()) {
          this.fail(command, "No API key found for the selected model.\n\nUse /login to log into a provider via OAuth or API key. See:\n  /synthetic/pkg/docs/providers.md\n  /synthetic/pkg/docs/models.md"); return;
        }
        if (this.state.isStreaming) {
          if (!command.streamingBehavior) { this.fail(command, "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message."); return; }
          this.enqueue(command.streamingBehavior === "followUp" ? "followUp" : "steering", text);
          this.respond(command, { disposition: "queued" }); return;
        }
        this.respond(command, { disposition: "started" });
        this.startRun(command); return;
      }
      // Observed: while idle these only park the message; no run starts.
      case "steer": this.enqueue("steering", String(command.message ?? "")); this.respond(command, { disposition: "queued" }); return;
      case "follow_up": this.enqueue("followUp", String(command.message ?? "")); this.respond(command, { disposition: "queued" }); return;
      case "clear_queue": {
        const cleared = { steering: [...this.queue.steering], followUp: [...this.queue.followUp] };
        this.queue = { steering: [], followUp: [] };
        this.send({ type: "queue_update", steering: [], followUp: [] });
        this.respond(command, cleared); return;
      }
      case "abort": {
        const run = this.activeRun;
        if (run) {
          this.send({ type: "message_end", message: { role: "assistant", content: [], stopReason: "aborted", errorMessage: "Request was aborted" } });
          run.finish({ aborted: true });
        }
        this.respond(command); return;
      }
      case "get_session_stats": this.respond(command, {
        sessionId: this.sessionId, userMessages: 1, assistantMessages: 1, toolCalls: 0, toolResults: 0, totalMessages: this.messages.length,
        tokens: { input: 100, output: 20, cacheRead: 40, cacheWrite: 0, total: 160 }, cost: 0.001,
        contextUsage: { tokens: 266, contextWindow: 32000, percent: 0.83 },
      }); return;
      case "get_commands": this.respond(command, { commands: (this.options.commands ?? []).map(item => ({ ...item, sourceInfo: { path: "/synthetic/ext", source: "local", scope: "user", origin: "top-level" } })) }); return;
      case "get_entries": this.respond(command, { entries: this.entries, leafId: this.entries[this.entries.length - 1]?.id ?? null }); return;
      case "get_tree": {
        const nodes = new Map<string, { entry: Record<string, unknown>; children: unknown[] }>();
        const roots: unknown[] = [];
        for (const entry of this.entries) nodes.set(entry.id as string, { entry, children: [] });
        for (const entry of this.entries) {
          const node = nodes.get(entry.id as string)!;
          const parent = entry.parentId ? nodes.get(entry.parentId as string) : undefined;
          (parent ? parent.children : roots).push(node);
        }
        this.respond(command, { tree: roots, leafId: this.entries[this.entries.length - 1]?.id ?? null }); return;
      }
      case "get_fork_messages": this.respond(command, { messages: this.entries.filter(entry => (entry.message as { role?: string } | undefined)?.role === "user").map(entry => ({ entryId: entry.id, text: (entry.message as { content: string }).content })) }); return;
      case "get_messages": this.respond(command, { messages: this.messages }); return;
      // Observed: `text` is omitted, not null, when there is none.
      case "get_last_assistant_text": { const last = [...this.messages].reverse().find(message => message.role === "assistant") as { content?: Array<{ text?: string }> } | undefined; this.respond(command, last?.content?.[0]?.text ? { text: last.content[0].text } : {}); return; }
      case "set_session_name": {
        const name = String(command.name ?? "").trim();
        if (!name) { this.fail(command, "Session name cannot be empty"); return; }
        this.state.sessionName = name; this.send({ type: "session_info_changed", name }); this.respond(command); return;
      }
      case "fork": case "clone": case "new_session": {
        if (command.type === "fork" && !this.entries.some(entry => entry.id === command.entryId)) { this.fail(command, "Invalid entry ID for forking"); return; }
        const next = `${command.type}-${this.entrySequence}-${Math.floor(Math.random() * 1e6)}`;
        const forkText = command.type === "fork" ? (this.entries.find(entry => entry.id === command.entryId)?.message as { content?: string } | undefined)?.content : undefined;
        this.state.sessionId = next;
        this.state.sessionFile = `/synthetic/sessions/2026-01-01T00-00-01-000Z_${next}.jsonl`;
        if (command.type === "new_session") { this.entries = []; this.messages = []; }
        this.respond(command, command.type === "fork" ? { text: forkText ?? "", cancelled: false } : { cancelled: false }); return;
      }
      case "compact": this.send({ type: "compaction_start", reason: "manual" }); this.send({ type: "compaction_end", reason: "manual", aborted: false, willRetry: false, errorMessage: "Nothing to compact (session too small)" }); this.fail(command, "Nothing to compact (session too small)"); return;
      case "bash": this.send({ type: "bash_execution_update", id: command.id, delta: "out\n" }); this.respond(command, { output: "out\n", exitCode: 0, cancelled: false, truncated: false }); return;
      case "export_html": this.respond(command, { path: String(command.outputPath ?? "/synthetic/export.html") }); return;
      case "set_steering_mode": this.state.steeringMode = command.mode; this.respond(command); return;
      case "set_follow_up_mode": this.state.followUpMode = command.mode; this.respond(command); return;
      case "set_auto_compaction": this.state.autoCompactionEnabled = command.enabled; this.respond(command); return;
      case "set_auto_retry": case "abort_retry": case "abort_bash": this.respond(command); return;
      case "switch_session": {
        // Observed: Pi switches even to a path that does not exist. Only then does the id come from the file name here.
        const target = String(command.sessionPath ?? "");
        const id = sessionHeaderId(target) ?? target.match(/_([^_/\\]+?)(?:-\d+)?\.jsonl$/)?.[1];
        if (this.options.cancelSwitch) { this.respond(command, { cancelled: true }); return; }
        if (id) { this.state.sessionId = id; this.state.sessionFile = target; this.entries = []; this.messages = []; }
        this.respond(command, { cancelled: false }); return;
      }
      case "cycle_model": case "cycle_thinking_level": this.respond(command, null); return;
      default: this.fail(command, `Unknown command: ${command.type}`);
    }
  }

  private enqueue(kind: "steering" | "followUp", text: string): void {
    this.queue[kind].push(text);
    this.send({ type: "queue_update", steering: [...this.queue.steering], followUp: [...this.queue.followUp] });
  }
}

/** A `spawnFn` that hands out fake processes and remembers them. */
export function fakePiSpawner(options: FakePiOptions | ((index: number, args: string[]) => FakePiOptions) = {}): { spawn: PiSpawn; processes: FakePiProcess[]; last(): FakePiProcess } {
  const processes: FakePiProcess[] = [];
  const spawn: PiSpawn = (command, args, spawnOptions) => {
    const resolved = typeof options === "function" ? options(processes.length, args) : options;
    const process = new FakePiProcess({ command, args, options: spawnOptions }, resolved);
    processes.push(process);
    return process as unknown as ChildProcess;
  };
  return { spawn, processes, last: () => processes[processes.length - 1]! };
}
