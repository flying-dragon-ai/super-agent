import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmdirSync, statSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { NativeAppPipe } from "./native-app-pipe.js";
import {
  PI_BRIDGE_COMMAND, PI_BRIDGE_ENDPOINT_ENV, PI_BRIDGE_PROTOCOL, PI_BRIDGE_TOKEN_ENV, type PiBridgeToolOrigin,
} from "./pi-bridge-extension.js";
import type { PiNativeTool } from "./pi-native-types.js";
import type { PiPromptDisposition } from "./pi-rpc-protocol.js";

/**
 * Host side of the open-super-agent bridge to a Pi process.
 *
 * `openPiBridgeEndpoint()` listens on a private local socket (a Unix domain
 * socket in a fresh 0700 directory; a random named pipe on Windows) and hands
 * the child `endpoint.env`. The bridge extension connects once and proves it
 * holds the one-time token in its first frame. Only the first connection is
 * accepted: the listener closes on accept, so a later connection cannot exist.
 * A wrong token, a malformed first frame, an extra connection during the
 * handshake or the timeout rejects `endpoint.connection` and tears it all down.
 *
 * After the handshake both directions use `NativeAppPipe` frames:
 *   extension -> Host (`PiBridgeHandler`): trust, instructions, approve, tool
 *     and lifecycle events. A handler that throws is answered with the safe
 *     default (undecided / no instructions / deny / error text), never a hang.
 *   Host -> extension (`PiBridgeConnection`): approval gate, App tool install,
 *     tool list and activation, labels, settings read, per-process MCP servers,
 *     and `control()`.
 *
 * `control()` covers operations Pi offers only to a command handler (tree
 * navigation, reload, fork at an entry). The Host stores the request under a
 * one-time id and the caller's `trigger` sends `/open-super-agent-bridge <id>` as an RPC
 * prompt; the extension command claims the request over the socket, runs it
 * and reports the result. `trigger` must reject, or return the prompt
 * disposition, when Pi did not handle the text as a command: a disposition
 * other than "handled" means it went to the model as prose.
 */

export { PI_BRIDGE_COMMAND, PI_BRIDGE_ENDPOINT_ENV, PI_BRIDGE_TOKEN_ENV, type PiBridgeToolOrigin } from "./pi-bridge-extension.js";

export interface PiBridgeToolDefinition { name: string; description: string; inputSchema: Record<string, unknown> }

export type PiBridgeEvent =
  | { type: "session_start"; reason: string; trusted?: boolean }
  | { type: "session_shutdown"; reason: string }
  | { type: "model_select"; provider: string; modelId: string; source: string }
  | { type: "user_bash"; command: string };

export interface PiBridgeHandler {
  /** Answer from stored decisions; Pi's startup waits on this (the extension gives up after 10 s). */
  trust(input: { cwd: string }): Promise<"yes" | "no" | "undecided">;
  /** Text appended to the system prompt of the run that is starting. */
  instructions(): Promise<string | undefined>;
  /**
   * `origin` says who implements the tool that would run, read from Pi's registry at call time:
   * `builtin` only for Pi's own tool under that name, `other` for anything else, including an
   * extension that registered `read` or `grep`. Never auto-allow on the name alone. `bridge` is
   * this bridge's own App tools, which the extension does not send here.
   * `inputTruncated` marks an input shortened to fit the frame limit. `signal` aborts when Pi cancels the run.
   */
  approve(input: { toolName: string; toolCallId: string; origin: PiBridgeToolOrigin; input: unknown; inputTruncated?: boolean }, signal: AbortSignal): Promise<{ allow: boolean; reason?: string }>;
  callTool(input: { name: string; callId: string; arguments: unknown }, signal: AbortSignal): Promise<{ text: string; isError?: boolean }>;
  onEvent(event: PiBridgeEvent): void;
}

export type PiBridgeControl =
  | { op: "navigate"; targetId: string; summarize?: boolean; customInstructions?: string; label?: string }
  | { op: "reload" }
  | { op: "fork-at"; entryId: string; position: "before" | "at" };
export interface PiBridgeControlResult { cancelled?: boolean }

/** timeout / no-result: the outcome is unknown. failed: Pi rejected the operation (message is native text). */
export class PiBridgeControlError extends Error {
  constructor(readonly reason: "closed" | "timeout" | "not-handled" | "no-result" | "failed" | "aborted", message?: string) {
    super(message ?? `Pi bridge control ${reason}`); this.name = "PiBridgeControlError";
  }
}
export class PiBridgeHandshakeError extends Error {
  constructor(readonly reason: "timeout" | "token" | "malformed" | "extra-connection" | "closed" | "disposed") {
    super(`Pi bridge handshake failed: ${reason}`); this.name = "PiBridgeHandshakeError";
  }
}

export interface PiBridgeConnection {
  /** true: every tool call that is not an App tool asks `approve`; false: Pi runs tools without asking. */
  setGate(gate: boolean): Promise<void>;
  /** Replaces the installed set. `skipped` names are invalid or collide with a tool the bridge does not own. */
  installTools(definitions: PiBridgeToolDefinition[]): Promise<{ installed: string[]; skipped: string[] }>;
  listTools(): Promise<PiBridgeTool[]>;
  setActiveTools(names: string[]): Promise<PiBridgeTool[]>;
  setLabel(entryId: string, label: string | null): Promise<void>;
  /** Pi's effective settings as an opaque object. */
  readSettings(): Promise<Record<string, unknown>>;
  /**
   * Replace the MCP servers this bridge registers in the Pi process (`pi.registerMcpServer`); nothing
   * is written to `mcp.json`. Each `config` is an `mcpServers` entry: stdio `{ command, args?, env?,
   * cwd?, exposure?, description?, toolExposure?, timeout?, enabled? }` or HTTP `{ url, headers? }`.
   * Returns the names Pi accepted; a config Pi rejects or a name another extension owns is left out.
   * A server of the same name in the owner's `mcp.json` still wins and Pi does not report that here,
   * so use a name the owner would not pick. `env` and `headers` values are templates: see
   * `escapePiConfigLiteral`. The extension re-registers the list after a reload or session replacement.
   */
  setMcpServers(servers: Array<{ name: string; config: Record<string, unknown> }>): Promise<string[]>;
  control(request: PiBridgeControl, options: {
    trigger(text: string): Promise<PiPromptDisposition | void>;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<PiBridgeControlResult>;
  readonly closed: Promise<void>;
  readonly isOpen: boolean;
  close(): void;
}

export type PiBridgeTool = PiNativeTool & { origin: PiBridgeToolOrigin };

/**
 * Pi resolves `env` and `headers` values of an MCP server as templates (core/resolve-config-value.ts
 * in Pi 1.5.2): `$NAME` and `${NAME}` read the Pi process environment, and a value starting with `!`
 * runs as a shell command. This returns the template for a literal value: `$` becomes `$$` and a
 * leading `!` becomes `$!`.
 */
export function escapePiConfigLiteral(value: string): string {
  const escaped = value.replace(/\$/g, "$$$$");
  return escaped.startsWith("!") ? `$${escaped}` : escaped;
}

export interface PiBridgeEndpoint {
  /** Merge into the child environment. The extension deletes both variables as soon as it loads. */
  env: Record<string, string>;
  connection: Promise<PiBridgeConnection>;
  /** Idempotent. Closes the listener and the connection and removes what this endpoint created. */
  dispose(): void;
}

/** Compiled extension next to this module; the TypeScript source when running from source (tsx, vitest). */
export function resolvePiBridgeExtensionPath(): string {
  const compiled = fileURLToPath(new URL("./pi-bridge-extension.js", import.meta.url));
  if (existsSync(compiled)) return compiled;
  const source = fileURLToPath(new URL("./pi-bridge-extension.ts", import.meta.url));
  return existsSync(source) ? source : compiled;
}

/** sun_path holds 104 bytes on macOS and 108 on Linux, including the terminator. */
export const PI_BRIDGE_UNIX_PATH_LIMIT = 100;

export type PiBridgeEndpointPlan =
  | { kind: "pipe"; endpoint: string }
  | { kind: "unix"; directory: string; endpoint: string; fits: boolean };

/** Where the listener would live. `id` is 16 random bytes in hex. */
export function planPiBridgeEndpoint(input: { stateDir: string; platform?: NodeJS.Platform; id: string }): PiBridgeEndpointPlan {
  if (!/^[0-9a-f]{32}$/.test(input.id)) throw new Error("Pi bridge endpoint id must be 32 hex characters");
  if ((input.platform ?? process.platform) === "win32") return { kind: "pipe", endpoint: `\\\\.\\pipe\\open-super-agent-pi-${input.id}` };
  const directory = path.join(input.stateDir, "pi", "bridge", input.id.slice(0, 8));
  const endpoint = path.join(directory, "s");
  return { kind: "unix", directory, endpoint, fits: Buffer.byteLength(endpoint) <= PI_BRIDGE_UNIX_PATH_LIMIT };
}

const helloSchema = z.object({
  v: z.literal(1), type: z.literal("request"), id: z.string().uuid(), method: z.literal("hello"),
  payload: z.object({ token: z.string().min(1).max(256), protocol: z.literal(PI_BRIDGE_PROTOCOL) }).strict(),
}).strict();
const originSchema = z.enum(["builtin", "bridge", "other"]);
const approveSchema = z.object({ toolName: z.string().max(256), toolCallId: z.string().max(512), origin: originSchema, input: z.unknown(), inputTruncated: z.literal(true).optional() }).strict();
const toolSchema = z.object({ name: z.string().min(1).max(64), callId: z.string().min(1).max(512), arguments: z.unknown() }).strict();
const eventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session_start"), reason: z.string().max(64), trusted: z.boolean().optional() }).strict(),
  z.object({ type: z.literal("session_shutdown"), reason: z.string().max(64) }).strict(),
  z.object({ type: z.literal("model_select"), provider: z.string().min(1).max(256), modelId: z.string().min(1).max(512), source: z.string().max(64) }).strict(),
  z.object({ type: z.literal("user_bash"), command: z.string().max(4000) }).strict(),
]);
const controlResultSchema = z.object({
  id: z.string().uuid(),
  result: z.object({ cancelled: z.boolean().optional() }).strict().optional(),
  error: z.string().max(2000).optional(),
}).strict();
const toolListSchema = z.object({
  tools: z.array(z.object({ name: z.string().min(1), active: z.boolean(), origin: originSchema, exposure: z.string().optional(), description: z.string().optional() }).strict()),
}).strict();
const installSchema = z.object({ installed: z.array(z.string()), skipped: z.array(z.string()) }).strict();

const HELLO_MAX_BYTES = 8 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const CONTROL_TIMEOUT_MS = 300_000;
/** The control result and the prompt response travel on different channels. */
const CONTROL_RESULT_GRACE_MS = 5_000;

type PendingControl = { request: PiBridgeControl; claimed: boolean; resolve(result: PiBridgeControlResult): void; reject(error: Error): void };

function createConnection(socket: Socket, handler: PiBridgeHandler): PiBridgeConnection {
  const controls = new Map<string, PendingControl>();
  let resolveClosed!: () => void;
  const closed = new Promise<void>(resolve => { resolveClosed = resolve; });

  const serve = async (method: string, payload: unknown, signal: AbortSignal): Promise<unknown> => {
    switch (method) {
      case "trust": {
        const cwd = z.object({ cwd: z.string().max(4096) }).strict().safeParse(payload);
        if (!cwd.success) return { trusted: "undecided" };
        try {
          const trusted = await handler.trust(cwd.data);
          return { trusted: trusted === "yes" || trusted === "no" ? trusted : "undecided" };
        } catch { return { trusted: "undecided" }; }
      }
      case "instructions": {
        try { const append = await handler.instructions(); return typeof append === "string" && append.trim() ? { append } : {}; }
        catch { return {}; }
      }
      case "approve": {
        const request = approveSchema.safeParse(payload);
        if (!request.success) return { allow: false, reason: "The approval request was malformed, so the tool was not run." };
        try {
          const decision = await handler.approve(request.data, signal);
          return decision?.allow === true ? { allow: true } : { allow: false, ...(typeof decision?.reason === "string" && decision.reason ? { reason: decision.reason.slice(0, 2000) } : {}) };
        } catch { return { allow: false, reason: "open-super-agent could not decide this approval, so the tool was not run." }; }
      }
      case "tool": {
        const call = toolSchema.safeParse(payload);
        if (!call.success) return { text: "The App tool request was malformed; nothing was sent.", isError: true };
        try {
          const result = await handler.callTool(call.data, signal);
          return typeof result?.text === "string" ? { text: result.text, ...(result.isError ? { isError: true } : {}) } : { text: "The App tool returned no result.", isError: true };
        } catch (error) {
          if (signal.aborted) throw error;
          return { text: "App tool result unavailable; delivery may have occurred. Check receipts before retrying.", isError: true };
        }
      }
      case "event": {
        const event = eventSchema.safeParse(payload);
        if (event.success) { try { handler.onEvent(event.data); } catch { /* listener errors stay local */ } }
        return null;
      }
      case "control-claim": {
        const id = z.object({ id: z.string().uuid() }).strict().safeParse(payload);
        const control = id.success ? controls.get(id.data.id) : undefined;
        if (!control || control.claimed) return null;
        control.claimed = true;
        return { request: control.request };
      }
      case "control-result": {
        const report = controlResultSchema.safeParse(payload);
        const control = report.success ? controls.get(report.data.id) : undefined;
        if (!report.success || !control || !control.claimed) return null;
        controls.delete(report.data.id);
        if (report.data.error !== undefined) control.reject(new PiBridgeControlError("failed", report.data.error || "Pi rejected the operation"));
        else control.resolve(report.data.result ?? {});
        return null;
      }
      default: return null;
    }
  };

  const pipe = new NativeAppPipe(socket, socket, serve, () => {
    for (const [id, control] of controls) { controls.delete(id); control.reject(new PiBridgeControlError("closed")); }
    resolveClosed();
  });
  const request = async <T>(method: string, payload: unknown, schema: z.ZodType<T>): Promise<T> =>
    schema.parse(await pipe.request(method, payload, undefined, REQUEST_TIMEOUT_MS));

  return {
    closed,
    get isOpen() { return pipe.available; },
    close: () => pipe.close(),
    async setGate(gate) { await request("policy", { gate }, z.object({ gate: z.literal(gate) }).strict()); },
    installTools: definitions => request("install-tools", { definitions }, installSchema),
    async listTools() { return (await request("tools", {}, toolListSchema)).tools; },
    async setActiveTools(names) { return (await request("set-active-tools", { names }, toolListSchema)).tools; },
    async setLabel(entryId, label) { await request("label", { entryId, label }, z.object({ ok: z.literal(true) }).strict()); },
    async readSettings() { return (await request("settings", {}, z.object({ settings: z.record(z.string(), z.unknown()) }).strict())).settings; },
    async setMcpServers(servers) { return (await request("mcp-servers", { servers }, z.object({ registered: z.array(z.string()) }).strict())).registered; },
    control(controlRequest, options) {
      if (!pipe.available) return Promise.reject(new PiBridgeControlError("closed"));
      if (options.signal?.aborted) return Promise.reject(new PiBridgeControlError("aborted"));
      const id = randomUUID();
      return new Promise<PiBridgeControlResult>((resolve, reject) => {
        let grace: ReturnType<typeof setTimeout> | undefined;
        const cleanup = () => { clearTimeout(timer); clearTimeout(grace); options.signal?.removeEventListener("abort", onAbort); };
        const fail = (error: Error) => { if (controls.delete(id)) { cleanup(); reject(error); } };
        const onAbort = () => fail(new PiBridgeControlError("aborted"));
        const timer = setTimeout(() => fail(new PiBridgeControlError("timeout")), options.timeoutMs ?? CONTROL_TIMEOUT_MS);
        controls.set(id, {
          request: controlRequest, claimed: false,
          resolve: result => { cleanup(); resolve(result); },
          reject: error => { cleanup(); reject(error); },
        });
        options.signal?.addEventListener("abort", onAbort, { once: true });
        Promise.resolve().then(() => options.trigger(`/${PI_BRIDGE_COMMAND} ${id}`)).then(disposition => {
          if (!controls.has(id)) return;
          if (disposition !== undefined && disposition !== "handled") { fail(new PiBridgeControlError("not-handled")); return; }
          grace = setTimeout(() => fail(new PiBridgeControlError("no-result")), CONTROL_RESULT_GRACE_MS);
        }, error => fail(error instanceof Error ? error : new Error(String(error))));
      });
    },
  };
}

function ownedDirectory(directory: string): boolean {
  try {
    const stat = lstatSync(directory);
    return stat.isDirectory() && !stat.isSymbolicLink() && (typeof process.getuid !== "function" || stat.uid === process.getuid());
  } catch { return false; }
}

/** Create one path component as a real directory this user owns; an existing one must already be that. */
function ensureOwnedDirectory(directory: string): void {
  try { mkdirSync(directory, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  if (!ownedDirectory(directory)) throw new Error("Pi bridge directory is not a private directory");
}

function createUnixEndpoint(stateDir: string, tmpDir: string): { directory: string; endpoint: string } {
  for (let attempt = 0; attempt < 4; attempt++) {
    const plan = planPiBridgeEndpoint({ stateDir, platform: "linux", id: randomBytes(16).toString("hex") });
    if (plan.kind !== "unix" || !plan.fits) break;
    if (!statSync(stateDir).isDirectory()) throw new Error("Pi bridge state directory is missing");
    ensureOwnedDirectory(path.join(stateDir, "pi"));
    ensureOwnedDirectory(path.join(stateDir, "pi", "bridge"));
    try { mkdirSync(plan.directory, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") continue; throw error; }
    if (!ownedDirectory(plan.directory)) throw new Error("Pi bridge directory is not a private directory");
    return { directory: plan.directory, endpoint: plan.endpoint };
  }
  // The state path is too long for sun_path: use a private temporary directory instead.
  const directory = mkdtempSync(path.join(tmpDir, "tb-pi-"));
  const endpoint = path.join(directory, "s");
  if (!ownedDirectory(directory) || Buffer.byteLength(endpoint) > PI_BRIDGE_UNIX_PATH_LIMIT) {
    try { rmdirSync(directory); } catch { /* nothing else was created */ }
    throw new Error("No directory short enough for the Pi bridge socket");
  }
  return { directory, endpoint };
}

export async function openPiBridgeEndpoint(input: {
  stateDir: string;
  handler: PiBridgeHandler;
  handshakeTimeoutMs?: number;
  platform?: NodeJS.Platform;
  /** Sent in the hello answer, so they hold before Pi finishes starting. gate defaults to true. */
  initial?: { gate?: boolean; tools?: PiBridgeToolDefinition[] };
  /** Fallback parent for the socket directory; defaults to os.tmpdir(). */
  tmpDir?: string;
}): Promise<PiBridgeEndpoint> {
  const platform = input.platform ?? process.platform;
  const token = randomBytes(32).toString("hex");
  const expected = Buffer.from(token, "utf8");
  const place = platform === "win32"
    ? { directory: undefined, endpoint: (planPiBridgeEndpoint({ stateDir: input.stateDir, platform, id: randomBytes(16).toString("hex") })).endpoint }
    : createUnixEndpoint(input.stateDir, input.tmpDir ?? os.tmpdir());

  let server: Server | undefined = createServer();
  let accepted: Socket | undefined;
  let connection: PiBridgeConnection | undefined;
  let settled = false, disposed = false;
  let resolveConnection!: (connection: PiBridgeConnection) => void, rejectConnection!: (error: Error) => void;
  const connectionPromise = new Promise<PiBridgeConnection>((resolve, reject) => { resolveConnection = resolve; rejectConnection = reject; });
  // A caller may dispose before awaiting; that must not surface as an unhandled rejection.
  connectionPromise.catch(() => {});

  const removeFiles = () => {
    if (!place.directory) return;
    try { if (lstatSync(place.endpoint).isSocket()) unlinkSync(place.endpoint); } catch { /* already gone */ }
    try { if (ownedDirectory(place.directory)) rmdirSync(place.directory); } catch { /* not empty or already gone */ }
  };
  const closeListener = () => {
    const listener = server; server = undefined;
    if (listener) { try { listener.close(); } catch { /* not listening */ } }
    removeFiles();
  };
  const fail = (reason: PiBridgeHandshakeError["reason"]) => {
    if (settled) return;
    settled = true; clearTimeout(timer);
    closeListener();
    accepted?.destroy();
    rejectConnection(new PiBridgeHandshakeError(reason));
  };
  const timer = setTimeout(() => fail("timeout"), input.handshakeTimeoutMs ?? 20_000);

  const handshake = (socket: Socket) => {
    let received = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      const end = received.indexOf(0x0a);
      if (end < 0) { if (received.length > HELLO_MAX_BYTES) fail("malformed"); return; }
      socket.off("data", onData);
      socket.pause();
      let hello: z.infer<typeof helloSchema>;
      try { hello = helloSchema.parse(JSON.parse(received.subarray(0, end).toString("utf8"))); }
      catch { fail("malformed"); return; }
      const given = Buffer.from(hello.payload.token, "utf8");
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) { fail("token"); return; }
      if (settled) return;
      settled = true; clearTimeout(timer);
      socket.off("close", onClose);
      const rest = received.subarray(end + 1);
      if (rest.length) socket.unshift(rest);
      socket.write(`${JSON.stringify({ v: 1, type: "response", id: hello.id, result: {
        protocol: PI_BRIDGE_PROTOCOL, gate: input.initial?.gate !== false, tools: input.initial?.tools ?? [],
      } })}\n`);
      connection = createConnection(socket, input.handler);
      // An explicitly paused stream stays paused when a data listener is added.
      socket.resume();
      resolveConnection(connection);
    };
    const onClose = () => fail("closed");
    socket.on("data", onData);
    socket.once("close", onClose);
    socket.on("error", () => {});
  };

  server.on("connection", socket => {
    if (accepted) {
      // Only reachable for a connection that was already queued when the first one was accepted.
      socket.destroy();
      if (!settled) fail("extra-connection");
      return;
    }
    accepted = socket;
    closeListener();
    if (settled) { socket.destroy(); return; }
    handshake(socket);
  });
  server.on("error", () => fail("closed"));

  try {
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(place.endpoint, () => { server?.off("error", reject); resolve(); });
    });
  } catch (error) {
    fail("closed");
    throw error;
  }

  return {
    env: { [PI_BRIDGE_ENDPOINT_ENV]: place.endpoint, [PI_BRIDGE_TOKEN_ENV]: token },
    connection: connectionPromise,
    dispose() {
      if (disposed) return;
      disposed = true;
      fail("disposed");
      closeListener();
      connection?.close();
      accepted?.destroy();
    },
  };
}
