import type { ChildProcess, SpawnOptions } from "node:child_process";
import { spawnEngine } from "../runtime/engine-process.js";
import { resolvePiLaunchCommand } from "../runtime/pi-executable.js";
import { killProcessTree } from "./process-tree.js";
import {
  PiJsonlDecoder, classifyPiError, encodePiRecord, isPiPlaceholderModel, parsePiFrame, sanitizePiErrorText,
  type PiCommand, type PiCommandType, type PiErrorKind, type PiExtensionUiRequest, type PiExtensionUiResponse,
  type PiResponseData, type PiResponseFrame, type PiSessionEvent,
} from "./pi-rpc-protocol.js";

export interface PiLaunchSpec { command: string; args: string[] }
export type PiSpawn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface PiRpcClientOptions {
  launch: PiLaunchSpec;
  cwd: string;
  /** Final child environment. The client adds nothing to it. */
  env: NodeJS.ProcessEnv;
  /** CLI arguments placed after `--mode rpc`. */
  args?: string[];
  /** Deadline for the first successful `get_state`. */
  startupTimeoutMs?: number;
  /** Aborting ends startup and stops the process. */
  signal?: AbortSignal;
  /** Attached before the first command, so dialogs an extension opens while Pi starts are seen too. */
  onExtensionUi?: (request: PiExtensionUiRequest, client: PiRpcClient) => void;
  onEvent?: (event: PiSessionEvent, client: PiRpcClient) => void;
  spawnFn?: PiSpawn;
  killProcessTreeFn?: (pid: number | undefined) => void | Promise<void>;
}

export interface PiExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** True when this client asked the process to stop. */
  expected: boolean;
  /** Sanitized tail of stderr; diagnostics only, never protocol data. */
  stderrTail: string;
}

/** The process never became a usable RPC peer. `exit` is set when it had already ended. */
export class PiStartupError extends Error {
  constructor(message: string, readonly reason: "spawn" | "exit" | "timeout" | "protocol", readonly exit?: PiExit) {
    super(message); this.name = "PiStartupError";
  }
}
/** Pi answered `success: false`. `message` is sanitized; `kind` classifies the native text. */
export class PiRpcCommandError extends Error {
  constructor(readonly command: string, message: string, readonly kind: PiErrorKind) { super(message); this.name = "PiRpcCommandError"; }
}
/** The process ended (or was never writable) before the command was answered. */
export class PiRpcClosedError extends Error {
  constructor(readonly command: string, readonly exit?: PiExit) { super(`Pi exited before answering ${command}`); this.name = "PiRpcClosedError"; }
}
/** No answer in time. The command may still take effect; the outcome is unknown. */
export class PiRpcTimeoutError extends Error {
  constructor(readonly command: string, readonly timeoutMs: number) { super(`Pi did not answer ${command} within ${timeoutMs} ms`); this.name = "PiRpcTimeoutError"; }
}

const STDERR_TAIL_CHARS = 8 * 1024;
/** After Pi has exited: how long both output pipes must stay quiet before the client stops waiting for them to close. */
const EXIT_STDIO_GRACE_MS = 1_000;
/** After Pi has exited: the longest the client keeps reading, however much another holder of the pipes still writes. */
const EXIT_STDIO_LIMIT_MS = 3_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const QUICK_COMMAND_TIMEOUT_MS = 30_000;
/** These run extension code, a shell command, a model call or a human dialog, so they have no default deadline. */
const UNBOUNDED_COMMANDS: ReadonlySet<PiCommandType> = new Set<PiCommandType>([
  "prompt", "steer", "follow_up", "abort", "compact", "bash", "new_session", "switch_session", "fork", "clone", "export_html",
]);

type Pending = { command: string; resolve(data: unknown): void; reject(error: Error): void; cleanup(): void };

export class PiRpcClient {
  private readonly pending = new Map<string, Pending>();
  private readonly eventListeners = new Set<(event: PiSessionEvent) => void>();
  private readonly uiListeners = new Set<(request: PiExtensionUiRequest) => void>();
  private readonly decoder = new PiJsonlDecoder();
  private stderrTail = "";
  private sequence = 0;
  private closing = false;
  private exit: PiExit | undefined;
  private writeChain: Promise<void> = Promise.resolve();
  private frames = 0;
  private closePromise: Promise<PiExit> | undefined;
  private spawnError: NodeJS.ErrnoException | undefined;
  readonly exited: Promise<PiExit>;

  private constructor(private readonly child: ChildProcess, private readonly killTree: (pid: number | undefined) => void | Promise<void>) {
    this.exited = new Promise(resolve => {
      let quiet: ReturnType<typeof setTimeout> | undefined;
      let settle: ReturnType<typeof setImmediate> | undefined;
      const finish = (code: number | null, signal: NodeJS.Signals | null) => {
        if (this.exit) return;
        clearTimeout(quiet);
        if (settle) clearImmediate(settle);
        try { for (const line of this.decoder.end()) this.receive(line); } catch { /* an oversized trailing record is dropped */ }
        this.exit = { code, signal, expected: this.closing, stderrTail: sanitizePiErrorText(this.stderrTail, 1200) };
        for (const [id, request] of this.pending) { this.pending.delete(id); request.cleanup(); request.reject(new PiRpcClosedError(request.command, this.exit)); }
        resolve(this.exit);
      };
      // `close` fires after stdio drained; `error` covers a failed spawn, where `close` may never come.
      child.once("close", finish);
      child.once("error", (error: NodeJS.ErrnoException) => { this.spawnError ??= error; finish(null, null); });
      // `close` also waits for every other process that holds these pipes. A process that inherited Pi's
      // stdout or stderr and outlives it (an extension's own helper, a launcher chain) would leave this
      // client "alive" with no peer: requests never answered, the session unusable until that process
      // ends. So once Pi has exited, wait only until both pipes have fallen quiet (output still arriving
      // is still read), and never longer than a fixed limit however much such a process writes; then
      // close our ends. Closing stdin is also Pi's own signal to shut down, should a Pi somehow remain
      // behind them.
      child.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
        const deadline = Date.now() + EXIT_STDIO_LIMIT_MS;
        const end = () => {
          if (this.exit) return;
          try { child.stdin?.destroy(); } catch { /* already closed */ }
          finish(code, signal);
          child.stdout?.destroy();
          child.stderr?.destroy();
        };
        const arm = () => {
          if (this.exit) return;
          clearTimeout(quiet);
          if (settle) { clearImmediate(settle); settle = undefined; }
          const remaining = deadline - Date.now();
          if (remaining <= 0) { end(); return; }
          quiet = setTimeout(() => {
            // A stalled event loop runs this timer before it delivers output that was already waiting
            // in the pipe. One more turn lets that output arrive, and re-arm, first.
            settle = setImmediate(() => { settle = undefined; end(); });
          }, Math.min(EXIT_STDIO_GRACE_MS, remaining));
          quiet.unref?.();
        };
        child.stdout?.on("data", arm);
        child.stderr?.on("data", arm);
        arm();
      });
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      let lines: string[];
      try { lines = this.decoder.push(chunk); } catch { this.terminate(); return; }
      for (const line of lines) this.receive(line);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL_CHARS);
    });
    // A dead pipe surfaces through `close`; an unhandled stream error would crash the Host.
    child.stdin?.on("error", () => {});
    child.stdout?.on("error", () => {});
    child.stderr?.on("error", () => {});
  }

  /** Spawn Pi in RPC mode and wait until it answers `get_state`. */
  static async start(options: PiRpcClientOptions): Promise<PiRpcClient> {
    if (options.signal?.aborted) throw options.signal.reason instanceof Error ? options.signal.reason : new Error("Aborted");
    const spawnFn = options.spawnFn ?? spawnEngine;
    // An injected spawn function receives the command as given; the real launch runs only a resolved file.
    const command = options.spawnFn ? options.launch.command : resolvePiLaunchCommand(options.launch.command, options.env);
    if (command === undefined) throw new PiStartupError("Pi executable was not found", "spawn");
    let child: ChildProcess;
    try {
      child = spawnFn(command, [...options.launch.args, "--mode", "rpc", ...(options.args ?? [])], {
        cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
      });
    } catch (error) {
      throw new PiStartupError(`Pi could not be started: ${error instanceof Error ? error.message : String(error)}`, "spawn");
    }
    const client = new PiRpcClient(child, options.killProcessTreeFn ?? (pid => killProcessTree(pid)));
    const { onExtensionUi, onEvent } = options;
    if (onExtensionUi) client.onExtensionUi(request => onExtensionUi(request, client));
    if (onEvent) client.onEvent(event => onEvent(event, client));
    const timeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    try {
      await client.request({ type: "get_state" }, { timeoutMs, ...(options.signal ? { signal: options.signal } : {}) });
      return client;
    } catch (error) {
      const exit = client.exit;
      client.terminate();
      if (options.signal?.aborted) throw options.signal.reason instanceof Error ? options.signal.reason : new Error("Aborted");
      if (error instanceof PiRpcTimeoutError) throw new PiStartupError(`Pi did not become ready within ${timeoutMs} ms`, "timeout");
      if (client.spawnError) {
        const code = client.spawnError.code;
        throw new PiStartupError(code === "ENOENT" ? "Pi executable was not found" : `Pi could not be started${code ? ` (${code})` : ""}`, "spawn");
      }
      if (error instanceof PiRpcClosedError) {
        // Exit 0 with no record happens when Pi asks a question on the terminal and reads our first command as the answer.
        const detail = exit?.stderrTail ? `: ${exit.stderrTail}` : "";
        throw new PiStartupError(`Pi exited during startup (code ${exit?.code ?? "none"}${exit?.signal ? `, ${exit.signal}` : ""})${detail}`, "exit", exit);
      }
      throw new PiStartupError(`Pi startup failed: ${error instanceof Error ? error.message : String(error)}`, "protocol", exit);
    }
  }

  get pid(): number | undefined { return this.child.pid; }
  get isAlive(): boolean { return !this.exit; }
  /** Number of valid records received so far. */
  get receivedFrames(): number { return this.frames; }

  request<T extends PiCommandType>(
    command: Extract<PiCommand, { type: T }>,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<PiResponseData<T>> {
    const type = command.type;
    if (this.exit || this.closing) return Promise.reject(new PiRpcClosedError(type, this.exit));
    if (options.signal?.aborted) return Promise.reject(options.signal.reason instanceof Error ? options.signal.reason : new Error("Aborted"));
    const timeoutMs = options.timeoutMs ?? (UNBOUNDED_COMMANDS.has(type) ? undefined : QUICK_COMMAND_TIMEOUT_MS);
    const id = `tb-${++this.sequence}`;
    return new Promise<PiResponseData<T>>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const abort = () => {
        if (!this.pending.delete(id)) return;
        cleanup();
        reject(options.signal?.reason instanceof Error ? options.signal.reason : new Error("Aborted"));
      };
      const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); };
      this.pending.set(id, { command: type, resolve: data => resolve(data as PiResponseData<T>), reject, cleanup });
      options.signal?.addEventListener("abort", abort, { once: true });
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => { if (this.pending.delete(id)) { cleanup(); reject(new PiRpcTimeoutError(type, timeoutMs)); } }, timeoutMs);
        timer.unref?.();
      }
      // Backpressure can keep this command in our queue after its caller has
      // cancelled or timed out. Only a command actually written to stdin may
      // still take effect; never send an abandoned queued operation later.
      this.write({ id, ...command }, () => this.pending.has(id)).catch(() => {
        if (this.pending.delete(id)) { cleanup(); reject(new PiRpcClosedError(type, this.exit)); }
      });
    });
  }

  onEvent(listener: (event: PiSessionEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => { this.eventListeners.delete(listener); };
  }

  /** Dialog requests block the extension until answered; a caller that listens must answer or cancel each one. */
  onExtensionUi(listener: (request: PiExtensionUiRequest) => void): () => void {
    this.uiListeners.add(listener);
    return () => { this.uiListeners.delete(listener); };
  }

  respondExtensionUi(response: PiExtensionUiResponse): void {
    if (this.exit || this.closing) return;
    void this.write(response).catch(() => {});
  }

  /**
   * Orderly stop: stdin EOF (Pi's own shutdown), then the process tree while its root still names
   * it, then SIGKILL on this child's own handle. Idempotent.
   *
   * The tree comes before any signal to the root. On Windows `kill()` is TerminateProcess of the
   * root alone, Pi's SIGTERM handler never runs, and `taskkill /T` cannot find the children of a
   * root that has gone; the official managed launcher makes that root cmd.exe, above
   * pi-launcher.js and Pi. On POSIX the tree killer still sends SIGTERM first.
   */
  close(options: { graceMs?: number } = {}): Promise<PiExit> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    const graceMs = options.graceMs ?? 5_000;
    this.closePromise = (async () => {
      // Records already queued (a dialog cancel, a last command) are written before stdin ends.
      await Promise.race([this.writeChain, new Promise<void>(resolve => { const timer = setTimeout(resolve, Math.min(graceMs, 1_000)); timer.unref?.(); })]);
      try { this.child.stdin?.end(); } catch { /* already closed */ }
      if (await this.exitedWithin(graceMs)) return this.exit!;
      await Promise.resolve().then(() => this.killTree(this.child.pid)).catch(() => {});
      if (await this.exitedWithin(2_000)) return this.exit!;
      // The tree killer signals only what it can enumerate (no pgrep/ps, a failed taskkill). This
      // handle names our own child, so it cannot reach a reused PID.
      try { this.child.kill("SIGKILL"); } catch { /* already gone */ }
      if (await this.exitedWithin(5_000)) return this.exit!;
      return { code: null, signal: null, expected: true, stderrTail: sanitizePiErrorText(this.stderrTail, 1200) };
    })();
    return this.closePromise;
  }

  /** Immediate stop for unusable peers; no orderly shutdown is attempted. */
  terminate(): void {
    this.closing = true;
    if (this.exit) return;
    try { this.child.stdin?.destroy(); } catch { /* already closed */ }
    void Promise.resolve(this.killTree(this.child.pid)).catch(() => {});
  }

  private exitedWithin(ms: number): Promise<boolean> {
    if (this.exit) return Promise.resolve(true);
    return new Promise(resolve => {
      const timer = setTimeout(() => resolve(false), ms);
      void this.exited.then(() => { clearTimeout(timer); resolve(true); });
    });
  }

  private write(record: object, shouldWrite?: () => boolean): Promise<void> {
    const line = encodePiRecord(record);
    const next = this.writeChain.then(() => new Promise<void>((resolve, reject) => {
      if (shouldWrite && !shouldWrite()) { resolve(); return; }
      const stdin = this.child.stdin;
      if (!stdin || stdin.destroyed || !stdin.writable || this.exit) { reject(new Error("Pi stdin is closed")); return; }
      // Honor backpressure: a large prompt (inline images) must not be interleaved or dropped.
      stdin.write(line, error => { if (error) reject(error); else resolve(); });
    }));
    this.writeChain = next.catch(() => {});
    return next;
  }

  private receive(line: string): void {
    const frame = parsePiFrame(line);
    if (frame.kind === "invalid") return;
    this.frames++;
    if (frame.kind === "response") { this.settle(frame.response); return; }
    if (frame.kind === "extension_ui") {
      for (const listener of [...this.uiListeners]) { try { listener(frame.request); } catch { /* listener errors never break the stream */ } }
      return;
    }
    for (const listener of [...this.eventListeners]) { try { listener(frame.event); } catch { /* same */ } }
  }

  private settle(response: PiResponseFrame): void {
    if (!response.id) return; // parse errors carry no id; the affected request ends by its own deadline
    const request = this.pending.get(response.id);
    if (!request) return;
    this.pending.delete(response.id);
    request.cleanup();
    if (response.success) { request.resolve(response.data); return; }
    const raw = response.error ?? "Pi rejected the command";
    request.reject(new PiRpcCommandError(request.command, sanitizePiErrorText(raw) || "Pi rejected the command", classifyPiError(raw)));
  }
}

export interface PiCatalogSnapshot {
  /** `get_available_models` as returned: only models whose provider has usable credentials. */
  models: unknown[];
  /** Native default selection; absent when no model is usable. */
  current?: { provider: string; modelId: string; thinkingLevel: string };
}

/**
 * Read the native model catalog with a short-lived `--no-session` process.
 * It never switches models or writes a session. `timeoutMs` bounds the whole
 * call, including process startup. Extension dialogs are cancelled: a catalog
 * read cannot consent to anything.
 */
export async function queryPiCatalog(input: {
  launch: PiLaunchSpec; cwd: string; env: NodeJS.ProcessEnv;
  extraArgs?: string[]; signal?: AbortSignal; timeoutMs?: number;
  spawnFn?: PiSpawn; killProcessTreeFn?: (pid: number | undefined) => void | Promise<void>;
}): Promise<PiCatalogSnapshot> {
  const timeoutMs = input.timeoutMs ?? 4_000;
  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(1, deadline - Date.now());
  input.signal?.throwIfAborted();
  const client = await PiRpcClient.start({
    launch: input.launch, cwd: input.cwd, env: input.env, args: ["--no-session", ...(input.extraArgs ?? [])],
    startupTimeoutMs: timeoutMs, spawnFn: input.spawnFn, killProcessTreeFn: input.killProcessTreeFn,
    ...(input.signal ? { signal: input.signal } : {}),
    // From the first record on: an extension may open a dialog while Pi is still starting.
    onExtensionUi: (request, peer) => {
      if (request.method === "select" || request.method === "confirm" || request.method === "input" || request.method === "editor") {
        peer.respondExtensionUi({ type: "extension_ui_response", id: request.id, cancelled: true });
      }
    },
  });
  try {
    const [models, state] = await Promise.all([
      client.request({ type: "get_available_models" }, { signal: input.signal, timeoutMs: remaining() }),
      client.request({ type: "get_state" }, { signal: input.signal, timeoutMs: remaining() }),
    ]);
    const model = state.model;
    return {
      models: Array.isArray(models?.models) ? models.models : [],
      ...(model && !isPiPlaceholderModel(model) ? { current: { provider: model.provider, modelId: model.id, thinkingLevel: String(state.thinkingLevel) } } : {}),
    };
  } finally {
    // Do not hold the caller for an orderly exit; the escalation continues in the background.
    void client.close({ graceMs: 300 }).catch(() => {});
  }
}
