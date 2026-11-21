import { randomUUID } from "node:crypto";
import { connect, type Socket } from "node:net";

/**
 * open-super-agent bridge extension. Pi loads this file with `-e <path>` inside its own
 * process (through jiti, from open-super-agent's dist), so it imports node built-ins
 * only: no zod, no open-super-agent modules, no Pi packages.
 *
 * It connects once to the Host's single-accept local socket, authenticates with
 * a one-time token and then serves both directions over the frame format of
 * `native-app-pipe.ts` (`{v:1,type:"request"|"response"|"cancel",id,...}`, LF
 * delimited, 1 MiB per frame):
 *   extension -> Host: hello, trust, instructions, approve, tool, event,
 *                      control-claim, control-result
 *   Host -> extension: policy, install-tools, tools, set-active-tools, label,
 *                      settings, mcp-servers
 *
 * Verified against Pi 1.5.2:
 * - The socket is never unref'd. During the startup `project_trust` wait it is
 *   the only live handle; an unref'd handle let the event loop drain and Pi
 *   exited 0 without writing a single RPC record.
 * - `/reload` and session replacement run this factory again. The connection
 *   lives on `globalThis`, so a later run reuses it and only re-registers its
 *   handlers and tools on the new extension API object.
 */

export const PI_BRIDGE_ENDPOINT_ENV = "open_super_agent_PI_BRIDGE_ENDPOINT";
export const PI_BRIDGE_TOKEN_ENV = "open_super_agent_PI_BRIDGE_TOKEN";
export const PI_BRIDGE_COMMAND = "open-super-agent-bridge";
export const PI_BRIDGE_PROTOCOL = 1;
export const PI_BRIDGE_GLOBAL_KEY = "open-super-agent.pi.bridge.v1";
/** Same cap as NativeAppPipe; the Host closes the pipe on a larger frame. */
export const PI_BRIDGE_MAX_FRAME_BYTES = 1024 * 1024;

const HELLO_TIMEOUT_MS = 10_000;
const QUICK_TIMEOUT_MS = 10_000;
const APPROVAL_INPUT_BUDGET_BYTES = 256 * 1024;
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Json = Record<string, unknown>;
type ToolDefinition = { name: string; description: string; inputSchema: Json };
type CallFailure = "closed" | "error" | "aborted" | "timeout" | "too-large";
type CallResult = { ok: true; result: unknown } | { ok: false; reason: CallFailure };
type ToolResult = { content: Array<{ type: "text"; text: string }>; details: Json; isError?: boolean };
type SourceInfo = { path?: unknown; source?: unknown };
/** builtin: implemented by Pi itself; bridge: an App tool this bridge installed; other: anything else. */
export type PiBridgeToolOrigin = "builtin" | "bridge" | "other";

/** The part of Pi's ExtensionAPI this file uses (types.ts in Pi 1.5.2). */
interface PiApi {
  on(event: string, handler: (event: any, ctx: any) => unknown): unknown;
  registerTool(definition: {
    name: string; label: string; description: string; parameters: unknown;
    execute(toolCallId: string, params: unknown, signal?: AbortSignal): Promise<ToolResult>;
  }): void;
  registerCommand(name: string, definition: { description?: string; handler(args: string, ctx: any): Promise<void> }): void;
  getAllTools?(): Array<{ name: string; description?: string; exposure?: string; sourceInfo?: SourceInfo }>;
  getCommands?(): Array<{ name: string; source?: string; sourceInfo?: SourceInfo }>;
  registerMcpServer?(name: string, config: Json): void;
  unregisterMcpServer?(name: string): void;
  getActiveTools?(): string[];
  setActiveTools?(names: string[]): void;
  setLabel?(entryId: string, label: string | undefined): void;
  getSettings?(): unknown;
}

interface Bridge {
  socket: Socket | undefined;
  closed: boolean;
  /** true until the Host says otherwise: an unanswered approval blocks the tool. */
  gate: boolean;
  loads: number;
  pi: PiApi | undefined;
  /** App tools of the latest install, by name. */
  tools: Map<string, ToolDefinition>;
  /** Every tool name this bridge has registered in this process. */
  ownTools: Set<string>;
  /** Definition last registered on each extension API object. */
  registered: WeakMap<PiApi, Map<string, string>>;
  /** This extension's own source path, as Pi reports it, per extension API object. */
  ownPath: WeakMap<PiApi, string>;
  /** MCP servers the Host wants in this process; re-registered on every load because Pi does not keep them. */
  mcpServers: Map<string, Json>;
  mcpRegistered: WeakMap<PiApi, Set<string>>;
  pending: Map<string, (result: CallResult) => void>;
  ready: Promise<void>;
  call(method: string, payload: unknown, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<CallResult>;
}

const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: string, isError = false): ToolResult => ({ content: [{ type: "text", text: value }], details: {}, ...(isError ? { isError: true } : {}) });

/** `rejected` lists the names of rows that are not usable tool definitions. */
function parseDefinitions(value: unknown): { definitions: ToolDefinition[]; rejected: string[] } {
  const definitions: ToolDefinition[] = [], rejected: string[] = [];
  for (const row of Array.isArray(value) ? value : []) {
    if (isRecord(row) && typeof row.name === "string" && TOOL_NAME.test(row.name) && typeof row.description === "string" && isRecord(row.inputSchema)) {
      definitions.push({ name: row.name, description: row.description, inputSchema: row.inputSchema });
    } else if (isRecord(row) && typeof row.name === "string") {
      rejected.push(row.name.slice(0, 64));
    }
  }
  return { definitions, rejected };
}

/**
 * Keep an approval request under the frame cap: a 2 MB `write` must still be askable.
 * This is only what the owner is shown; the tool still runs with its full input. Every
 * shortening is marked where it happened, so an approval never covers items the card
 * silently left out (Pi's own `edit` takes an `edits` array).
 */
function boundedInput(input: unknown): { input: unknown; inputTruncated?: true } {
  let json: string;
  try { json = JSON.stringify(input) ?? "null"; } catch { return { input: { notice: "The tool input cannot be shown." }, inputTruncated: true }; }
  if (Buffer.byteLength(json) <= APPROVAL_INPUT_BUDGET_BYTES) return { input };
  const clip = (value: unknown, depth: number): unknown => {
    if (typeof value === "string") return value.length > 4000 ? `${value.slice(0, 4000)}… [${value.length - 4000} more characters]` : value;
    if (depth >= 4 || typeof value !== "object" || value === null) return typeof value === "object" && value !== null ? "[omitted]" : value;
    if (Array.isArray(value)) {
      const kept = value.slice(0, 50).map(item => clip(item, depth + 1));
      return value.length > 50 ? [...kept, `… [${value.length - 50} more items not shown]`] : kept;
    }
    const entries = Object.entries(value);
    const kept: Json = Object.fromEntries(entries.slice(0, 50).map(([key, item]) => [key, clip(item, depth + 1)]));
    if (entries.length > 50) {
      let key = "…";
      while (Object.hasOwn(kept, key)) key += "…";
      kept[key] = `[${entries.length - 50} more fields not shown]`;
    }
    return kept;
  };
  // Said first, ahead of the bulk it shortens; the marks below say where and how much.
  const notice = "This preview is shortened; marked parts are not shown. The tool runs with its full input.";
  const clipped = clip(input, 0);
  let shown: unknown = clipped;
  if (Array.isArray(clipped)) shown = [notice, ...clipped];
  else if (isRecord(clipped)) {
    let key = "⚠";
    while (Object.hasOwn(clipped, key)) key += "⚠";
    shown = { [key]: notice, ...clipped };
  } else if (typeof clipped === "string") shown = `[${notice}] ${clipped}`;
  if (Buffer.byteLength(JSON.stringify(shown) ?? "null") <= APPROVAL_INPUT_BUDGET_BYTES) return { input: shown, inputTruncated: true };
  return { input: { notice: `This preview is shortened: the tool input is too large to show in full (${Buffer.byteLength(json)} bytes); only its beginning is shown. The tool runs with its full input.`, preview: json.slice(0, 8000) }, inputTruncated: true };
}

/**
 * The path Pi assigned to this extension, read from the one command only this extension registers.
 * Unknown (and never cached) while the runtime is not bound or when that command is not unique.
 */
function ownSourcePath(bridge: Bridge, pi: PiApi): string | undefined {
  const known = bridge.ownPath.get(pi);
  if (known) return known;
  try {
    const mine = (pi.getCommands?.() ?? []).filter(command => command?.name === PI_BRIDGE_COMMAND && command.source === "extension");
    const path = mine.length === 1 ? mine[0]!.sourceInfo?.path : undefined;
    if (typeof path !== "string" || !path || path.startsWith("builtin:")) return undefined;
    bridge.ownPath.set(pi, path);
    return path;
  } catch { return undefined; }
}

/**
 * Who implements the tool that would run under this name right now. A name proves nothing: an
 * extension may register `read` and replace the built-in (Pi's tool-override example does), so the
 * answer comes from the registry entry's `sourceInfo` (Pi 1.5.2):
 * - A base tool carries `{ path: "builtin:<tool name>", source: "builtin" }`
 *   (core/agent-session.ts:3667-3676, core/source-info.ts:61-78).
 * - An extension tool of the same name replaces that entry and carries the extension's own
 *   sourceInfo, its file path (agent-session.ts:3677-3682); between extensions the first one to
 *   register a name keeps it (core/extensions/runner.ts:637-647).
 * - Pi's bundled extensions load from `builtin:<extension>` paths with source "builtin"
 *   (extensions/index.ts:7-14, core/resource-loader.ts:758-786): `codemode` from
 *   `builtin:codemode`, `tool_search` from `builtin:tool-search`, and every MCP server tool plus the
 *   three MCP resource tools from `builtin:mcp`. So source "builtin" alone is not enough: MCP
 *   tools have it too. Only the exact path for the name counts.
 * `bridge` additionally requires the entry to come from this extension's own path. Anything
 * missing, duplicated or unreadable is `other`. This guards against overrides, not against hostile
 * in-process code: an extension runs with the same rights as this one.
 */
function toolOrigin(bridge: Bridge, pi: PiApi | undefined, toolName: string): PiBridgeToolOrigin {
  let info: SourceInfo | undefined;
  try {
    const entries = (pi?.getAllTools?.() ?? []).filter(tool => tool?.name === toolName);
    if (entries.length !== 1) return "other";
    info = entries[0]!.sourceInfo;
  } catch { return "other"; }
  if (!isRecord(info) || typeof info.path !== "string" || typeof info.source !== "string") return "other";
  if (info.source === "builtin") {
    return info.path === `builtin:${toolName}` || (toolName === "tool_search" && info.path === "builtin:tool-search") ? "builtin" : "other";
  }
  if (bridge.ownTools.has(toolName) && bridge.tools.has(toolName) && pi && info.path === ownSourcePath(bridge, pi)) return "bridge";
  return "other";
}

function listTools(bridge: Bridge, pi: PiApi | undefined): Array<{ name: string; active: boolean; origin: PiBridgeToolOrigin; exposure?: string; description?: string }> {
  if (!pi?.getAllTools) return [];
  const active = new Set(pi.getActiveTools?.() ?? []);
  return pi.getAllTools().filter(tool => tool && typeof tool.name === "string").map(tool => ({
    name: tool.name, active: active.has(tool.name), origin: toolOrigin(bridge, pi, tool.name),
    ...(typeof tool.exposure === "string" ? { exposure: tool.exposure } : {}),
    ...(typeof tool.description === "string" ? { description: tool.description.slice(0, 2000) } : {}),
  }));
}

/** Register the Host's MCP servers on this API object and drop the ones that left the list. */
function syncMcpServers(bridge: Bridge, pi: PiApi): string[] {
  let previous = bridge.mcpRegistered.get(pi);
  if (!previous) { previous = new Set(); bridge.mcpRegistered.set(pi, previous); }
  const registered: string[] = [];
  for (const [name, config] of bridge.mcpServers) {
    // Pi validates the config and throws for a name another extension owns.
    try { pi.registerMcpServer?.(name, config); if (pi.registerMcpServer) registered.push(name); } catch { /* reported as not registered */ }
  }
  for (const name of previous) {
    if (!bridge.mcpServers.has(name)) { try { pi.unregisterMcpServer?.(name); } catch { /* already gone */ } }
  }
  bridge.mcpRegistered.set(pi, new Set(registered));
  return registered;
}

/** Register the installed App tools on this API object and keep their activation in step. */
function syncTools(bridge: Bridge, pi: PiApi): { installed: string[]; skipped: string[] } {
  let known = bridge.registered.get(pi);
  if (!known) { known = new Map(); bridge.registered.set(pi, known); }
  const installed: string[] = [], skipped: string[] = [];
  let foreign = new Set<string>();
  try { foreign = new Set((pi.getAllTools?.() ?? []).map(tool => tool.name).filter(name => !bridge.ownTools.has(name) && !known!.has(name))); } catch { /* treated as no foreign tools */ }
  for (const definition of bridge.tools.values()) {
    // Never shadow a built-in or another extension's tool: ours are exempt from the approval gate.
    if (foreign.has(definition.name)) { skipped.push(definition.name); continue; }
    const fingerprint = JSON.stringify([definition.description, definition.inputSchema]);
    if (known.get(definition.name) !== fingerprint) {
      const name = definition.name;
      try {
        pi.registerTool({
          name, label: name, description: definition.description, parameters: definition.inputSchema,
          async execute(toolCallId, params, signal) {
            if (!bridge.tools.has(name)) return text("This App tool is not available in the current conversation; nothing was sent.", true);
            const reply = await bridge.call("tool", { name, callId: String(toolCallId), arguments: params }, { signal });
            if (reply.ok && isRecord(reply.result) && typeof reply.result.text === "string") return text(reply.result.text, reply.result.isError === true);
            if (!reply.ok && reply.reason === "too-large") return text("The arguments exceed the App tool size limit; nothing was sent.", true);
            if (!reply.ok && reply.reason === "aborted") return text("The App tool call was cancelled; delivery may have occurred. Check receipts before retrying.", true);
            return text("App tool result unavailable; delivery may have occurred. Check receipts before retrying.", true);
          },
        });
      } catch { skipped.push(name); continue; }
      known.set(name, fingerprint);
      bridge.ownTools.add(name);
    }
    installed.push(definition.name);
  }
  // Pi has no unregister: hide tools that left the install and re-show the ones that came back.
  try {
    if (pi.getActiveTools && pi.setActiveTools) {
      const active = pi.getActiveTools();
      const wanted = new Set(installed);
      const next = active.filter(name => !bridge.ownTools.has(name) || wanted.has(name));
      for (const name of installed) if (!next.includes(name)) next.push(name);
      if (next.length !== active.length || next.some((name, index) => name !== active[index])) pi.setActiveTools(next);
    }
  } catch { /* activation is best effort; execute() still refuses tools outside the install */ }
  return { installed, skipped };
}

async function serveHost(bridge: Bridge, method: string, payload: unknown): Promise<unknown> {
  const pi = bridge.pi;
  const body = isRecord(payload) ? payload : {};
  if (method === "policy") { bridge.gate = body.gate !== false; return { gate: bridge.gate }; }
  if (!pi) throw new Error("extension is not initialized");
  switch (method) {
    case "install-tools": {
      const { definitions, rejected } = parseDefinitions(body.definitions);
      bridge.tools = new Map(definitions.map(definition => [definition.name, definition]));
      const outcome = syncTools(bridge, pi);
      return { installed: outcome.installed, skipped: [...outcome.skipped, ...rejected] };
    }
    case "tools": return { tools: listTools(bridge, pi) };
    case "set-active-tools": {
      if (!Array.isArray(body.names) || !body.names.every(name => typeof name === "string") || !pi.setActiveTools) throw new Error("invalid request");
      pi.setActiveTools(body.names as string[]);
      return { tools: listTools(bridge, pi) };
    }
    case "label": {
      if (typeof body.entryId !== "string" || !body.entryId || !pi.setLabel) throw new Error("invalid request");
      pi.setLabel(body.entryId, typeof body.label === "string" && body.label ? body.label : undefined);
      return { ok: true };
    }
    case "settings": return { settings: pi.getSettings?.() ?? {} };
    case "mcp-servers": {
      if (!Array.isArray(body.servers)) throw new Error("invalid request");
      const servers = new Map<string, Json>();
      for (const row of body.servers) {
        if (!isRecord(row) || typeof row.name !== "string" || !TOOL_NAME.test(row.name) || !isRecord(row.config)) throw new Error("invalid request");
        servers.set(row.name, row.config);
      }
      bridge.mcpServers = servers;
      return { registered: syncMcpServers(bridge, pi) };
    }
    default: throw new Error("unknown method");
  }
}

function openBridge(endpoint: string, token: string): Bridge {
  const socket = connect(endpoint);
  let buffer = "";
  const write = (frame: Json): boolean => {
    if (bridge.closed || socket.destroyed) return false;
    let line: string;
    try { line = `${JSON.stringify(frame)}\n`; } catch { return false; }
    if (Buffer.byteLength(line) > PI_BRIDGE_MAX_FRAME_BYTES) return false;
    socket.write(line);
    return true;
  };
  const close = () => {
    if (bridge.closed) return;
    bridge.closed = true; buffer = "";
    for (const finish of [...bridge.pending.values()]) finish({ ok: false, reason: "closed" });
    bridge.pending.clear();
    socket.destroy();
  };
  const bridge: Bridge = {
    socket, closed: false, gate: true, loads: 0, pi: undefined,
    tools: new Map(), ownTools: new Set(), registered: new WeakMap(), pending: new Map(),
    ownPath: new WeakMap(), mcpServers: new Map(), mcpRegistered: new WeakMap(),
    ready: Promise.resolve(),
    call(method, payload, options = {}) {
      if (bridge.closed) return Promise.resolve({ ok: false, reason: "closed" });
      if (options.signal?.aborted) return Promise.resolve({ ok: false, reason: "aborted" });
      return new Promise<CallResult>(resolve => {
        const id = randomUUID();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (result: CallResult) => {
          if (!bridge.pending.delete(id)) return;
          clearTimeout(timer); options.signal?.removeEventListener("abort", onAbort);
          resolve(result);
        };
        const withdraw = (reason: CallFailure) => { if (bridge.pending.has(id)) { write({ v: 1, type: "cancel", id }); finish({ ok: false, reason }); } };
        const onAbort = () => withdraw("aborted");
        bridge.pending.set(id, finish);
        options.signal?.addEventListener("abort", onAbort, { once: true });
        if (options.timeoutMs !== undefined) timer = setTimeout(() => withdraw("timeout"), options.timeoutMs);
        if (!write({ v: 1, type: "request", id, method, payload })) finish({ ok: false, reason: bridge.closed ? "closed" : "too-large" });
      });
    },
  };
  const receive = (line: string) => {
    let frame: unknown;
    try { frame = JSON.parse(line); } catch { close(); return; }
    if (!isRecord(frame) || frame.v !== 1 || typeof frame.id !== "string" || !UUID.test(frame.id)) { close(); return; }
    const id = frame.id;
    if (frame.type === "response") {
      bridge.pending.get(id)?.(frame.error === true ? { ok: false, reason: "error" } : { ok: true, result: frame.result });
      return;
    }
    if (frame.type === "cancel") return; // Host requests are short and not interruptible
    if (frame.type !== "request" || typeof frame.method !== "string") { close(); return; }
    void serveHost(bridge, frame.method, frame.payload).then(
      result => { if (!write({ v: 1, type: "response", id, result })) write({ v: 1, type: "response", id, error: true }); },
      () => { write({ v: 1, type: "response", id, error: true }); },
    );
  };
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    for (let end = buffer.indexOf("\n"); end >= 0 && !bridge.closed; end = buffer.indexOf("\n")) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (Buffer.byteLength(line) > PI_BRIDGE_MAX_FRAME_BYTES) { close(); return; }
      receive(line);
    }
    if (Buffer.byteLength(buffer) > PI_BRIDGE_MAX_FRAME_BYTES) close();
  });
  socket.on("error", close);
  socket.on("close", close);
  bridge.ready = bridge.call("hello", { token, protocol: PI_BRIDGE_PROTOCOL }, { timeoutMs: HELLO_TIMEOUT_MS }).then(reply => {
    if (!reply.ok || !isRecord(reply.result) || reply.result.protocol !== PI_BRIDGE_PROTOCOL) { close(); return; }
    bridge.gate = reply.result.gate !== false;
    bridge.tools = new Map(parseDefinitions(reply.result.tools).definitions.map(definition => [definition.name, definition]));
  });
  return bridge;
}

function acquireBridge(): Bridge | undefined {
  const store = globalThis as unknown as Record<symbol, Bridge | undefined>;
  const key = Symbol.for(PI_BRIDGE_GLOBAL_KEY);
  const endpoint = process.env[PI_BRIDGE_ENDPOINT_ENV], token = process.env[PI_BRIDGE_TOKEN_ENV];
  // Tools run by the model inherit process.env; the handoff must not outlive this line.
  delete process.env[PI_BRIDGE_ENDPOINT_ENV];
  delete process.env[PI_BRIDGE_TOKEN_ENV];
  const existing = store[key];
  if (existing) return existing;
  if (!endpoint || !token) return undefined;
  return (store[key] = openBridge(endpoint, token));
}

export default async function openSuperAgentPiBridge(pi: PiApi): Promise<void> {
  const bridge = acquireBridge();
  // Loaded by a Pi that open-super-agent did not start: stay inert.
  if (!bridge) return;
  bridge.loads++;
  bridge.pi = pi;
  await bridge.ready;
  syncTools(bridge, pi);
  syncMcpServers(bridge, pi);
  const notify = (event: Json) => { void bridge.call("event", event, { timeoutMs: QUICK_TIMEOUT_MS }); };

  pi.on("project_trust", async (event: any) => {
    const reply = await bridge.call("trust", { cwd: String(event?.cwd ?? "") }, { timeoutMs: QUICK_TIMEOUT_MS });
    const trusted = reply.ok && isRecord(reply.result) ? reply.result.trusted : undefined;
    return { trusted: trusted === "yes" || trusted === "no" ? trusted : "undecided", remember: false };
  });

  pi.on("before_agent_start", async (event: any) => {
    const reply = await bridge.call("instructions", {}, { timeoutMs: QUICK_TIMEOUT_MS });
    const append = reply.ok && isRecord(reply.result) && typeof reply.result.append === "string" ? reply.result.append : "";
    if (!append.trim()) return undefined;
    return { systemPrompt: `${String(event?.systemPrompt ?? "")}\n\n${append}` };
  });

  pi.on("tool_call", async (event: any, ctx: any) => {
    const toolName = String(event?.toolName ?? "");
    // Only this bridge's own App tools skip the Host, and only when the registry says the entry is ours.
    const origin = toolOrigin(bridge, bridge.pi, toolName);
    if (origin === "bridge") return undefined;
    if (!bridge.gate) return undefined;
    const reply = await bridge.call("approve", { toolName, toolCallId: String(event?.toolCallId ?? ""), origin, ...boundedInput(event?.input) }, { signal: ctx?.signal });
    if (reply.ok && isRecord(reply.result) && reply.result.allow === true) return undefined;
    if (!reply.ok && reply.reason === "aborted") return { block: true, reason: "Cancelled before approval." };
    if (reply.ok && isRecord(reply.result) && reply.result.allow === false) {
      return { block: true, reason: typeof reply.result.reason === "string" && reply.result.reason ? reply.result.reason : "Denied in open-super-agent." };
    }
    // Fail closed: no answer is never an approval.
    return { block: true, reason: "open-super-agent approval is unavailable, so the tool was not run." };
  });

  pi.on("session_start", (event: any, ctx: any) => {
    let trusted: boolean | undefined;
    try { const value = ctx?.isProjectTrusted?.(); if (typeof value === "boolean") trusted = value; } catch { /* unknown */ }
    notify({ type: "session_start", reason: String(event?.reason ?? ""), ...(trusted === undefined ? {} : { trusted }) });
  });
  pi.on("session_shutdown", (event: any) => { notify({ type: "session_shutdown", reason: String(event?.reason ?? "") }); });
  pi.on("model_select", (event: any) => {
    const model = event?.model;
    if (typeof model?.provider !== "string" || typeof model?.id !== "string") return;
    notify({ type: "model_select", provider: model.provider, modelId: model.id, source: String(event?.source ?? "") });
  });
  pi.on("user_bash", (event: any) => { notify({ type: "user_bash", command: String(event?.command ?? "").slice(0, 4000) }); return undefined; });

  // Session controls exist only on a command context. The Host stores the request and sends
  // `/open-super-agent-bridge <one-time id>`; an id it did not issue claims nothing, so typing the
  // command or a model emitting it has no effect.
  pi.registerCommand(PI_BRIDGE_COMMAND, {
    description: "open-super-agent host control (internal)",
    handler: async (args: string, ctx: any) => {
      const id = String(args ?? "").trim();
      if (!UUID.test(id)) return;
      const claim = await bridge.call("control-claim", { id }, { timeoutMs: QUICK_TIMEOUT_MS });
      const request = claim.ok && isRecord(claim.result) && isRecord(claim.result.request) ? claim.result.request : undefined;
      if (!request) return;
      try {
        let result: Json;
        if (request.op === "navigate" && typeof request.targetId === "string") {
          const outcome = await ctx.navigateTree(request.targetId, {
            summarize: request.summarize === true,
            ...(typeof request.customInstructions === "string" ? { customInstructions: request.customInstructions } : {}),
            ...(typeof request.label === "string" && request.label ? { label: request.label } : {}),
          });
          result = { cancelled: outcome?.cancelled === true };
        } else if (request.op === "reload") {
          await ctx.reload();
          result = {};
        } else if (request.op === "fork-at" && typeof request.entryId === "string") {
          const outcome = await ctx.fork(request.entryId, { position: request.position === "at" ? "at" : "before" });
          result = { cancelled: outcome?.cancelled === true };
        } else {
          throw new Error("Unsupported control request");
        }
        await bridge.call("control-result", { id, result }, { timeoutMs: QUICK_TIMEOUT_MS });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await bridge.call("control-result", { id, error: message.slice(0, 2000) || "Control request failed" }, { timeoutMs: QUICK_TIMEOUT_MS });
      }
    },
  });
}
