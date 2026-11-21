import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import openSuperAgentPiBridge, {
  PI_BRIDGE_COMMAND, PI_BRIDGE_ENDPOINT_ENV, PI_BRIDGE_GLOBAL_KEY, PI_BRIDGE_TOKEN_ENV,
} from "../src/codex/pi-bridge-extension.js";
import {
  PI_BRIDGE_UNIX_PATH_LIMIT, PiBridgeControlError, PiBridgeHandshakeError, escapePiConfigLiteral, openPiBridgeEndpoint, planPiBridgeEndpoint,
  resolvePiBridgeExtensionPath, type PiBridgeConnection, type PiBridgeEndpoint, type PiBridgeEvent, type PiBridgeHandler, type PiBridgeToolOrigin,
} from "../src/codex/pi-bridge-host.js";

type Handler = (event: any, ctx: any) => any;
type RegisteredTool = { name: string; label: string; description: string; parameters: unknown; execute(id: string, params: unknown, signal?: AbortSignal): Promise<any> };

const EXTENSION_PATH = "/srv/open-super-agent/dist/pi-bridge-extension.js";
const builtinSource = (name: string) => ({ path: `builtin:${name}`, source: "builtin", scope: "temporary", origin: "top-level" });
const extensionSource = (file: string) => ({ path: file, source: "cli", scope: "temporary", origin: "top-level" });
type FakeTool = { name: string; description: string; exposure: string; sourceInfo?: { path?: unknown; source?: unknown } };

/** Records what the extension registers, the way Pi's ExtensionAPI would hold it (source info included). */
function fakePi() {
  const handlers = new Map<string, Handler>();
  const tools = new Map<string, RegisteredTool>();
  const commands = new Map<string, { handler(args: string, ctx: any): Promise<void> }>();
  const labels: Array<[string, string | undefined]> = [];
  const registrations: string[] = [];
  const mcp = new Map<string, Record<string, unknown>>();
  const mcpLog: string[] = [];
  let active = ["read", "bash"];
  /** Base tools and tools of other extensions; a test may replace or add entries. */
  const foreign = new Map<string, FakeTool>([
    ["read", { name: "read", description: "Read a file", exposure: "direct", sourceInfo: builtinSource("read") }],
    ["bash", { name: "bash", description: "Run a command", exposure: "direct", sourceInfo: builtinSource("bash") }],
    ["grep", { name: "grep", description: "Search", exposure: "direct", sourceInfo: builtinSource("grep") }],
  ]);
  const state = { toolsReadable: true, commandPath: EXTENSION_PATH as string | undefined };
  const api = {
    on(event: string, handler: Handler) { handlers.set(event, handler); },
    registerTool(definition: RegisteredTool) { registrations.push(definition.name); if (!tools.has(definition.name)) active.push(definition.name); tools.set(definition.name, definition); },
    registerCommand(name: string, definition: { handler(args: string, ctx: any): Promise<void> }) { commands.set(name, definition); },
    getAllTools: (): FakeTool[] => {
      if (!state.toolsReadable) throw new Error("Extension runtime not initialized");
      // As in Pi, an extension tool replaces a base tool of the same name; an earlier extension keeps its name.
      const merged = new Map(foreign);
      for (const tool of tools.values()) {
        const existing = merged.get(tool.name);
        if (!existing || existing.sourceInfo?.source === "builtin") merged.set(tool.name, { name: tool.name, description: tool.description, exposure: "direct", sourceInfo: extensionSource(EXTENSION_PATH) });
      }
      return [...merged.values()];
    },
    getCommands: () => [...commands.keys()].map(name => ({ name, source: "extension", sourceInfo: state.commandPath ? extensionSource(state.commandPath) : undefined })),
    getActiveTools: () => [...active],
    setActiveTools(names: string[]) { active = [...names]; },
    setLabel(entryId: string, label: string | undefined) { labels.push([entryId, label]); },
    getSettings: () => ({ defaultProvider: "synthetic", compaction: { enabled: true } }),
    registerMcpServer(name: string, config: Record<string, unknown>) {
      if (typeof config.command !== "string" && typeof config.url !== "string") throw new Error(`Invalid MCP server "${name}"`);
      mcp.set(name, config); mcpLog.push(`+${name}`);
    },
    unregisterMcpServer(name: string) { if (mcp.delete(name)) mcpLog.push(`-${name}`); },
  };
  return { api, handlers, tools, commands, labels, registrations, foreign, state, mcp, mcpLog, active: () => active };
}

function recordingHandler(overrides: Partial<PiBridgeHandler> = {}) {
  const events: PiBridgeEvent[] = [];
  const approvals: Array<{ toolName: string; toolCallId: string; origin: PiBridgeToolOrigin; input: unknown; inputTruncated?: boolean }> = [];
  const calls: Array<{ name: string; callId: string; arguments: unknown }> = [];
  const handler: PiBridgeHandler = {
    trust: async () => "yes",
    instructions: async () => "HOST-MARKER",
    approve: async input => { approvals.push(input); return { allow: true }; },
    callTool: async input => { calls.push(input); return { text: `echo:${JSON.stringify(input.arguments)}` }; },
    onEvent: event => { events.push(event); },
    ...overrides,
  };
  return { handler, events, approvals, calls };
}

const cleanups: Array<() => unknown> = [];
const endpointPath = (endpoint: PiBridgeEndpoint) => endpoint.env[PI_BRIDGE_ENDPOINT_ENV]!;

async function stateDir(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-bridge-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function openEndpoint(handler: PiBridgeHandler, options: Partial<Parameters<typeof openPiBridgeEndpoint>[0]> = {}): Promise<PiBridgeEndpoint> {
  const endpoint = await openPiBridgeEndpoint({ stateDir: options.stateDir ?? await stateDir(), handler, handshakeTimeoutMs: 2_000, ...options });
  cleanups.push(() => endpoint.dispose());
  return endpoint;
}

/** Load the extension the way a freshly spawned Pi would: with the handoff in its environment. */
async function loadExtension(endpoint: PiBridgeEndpoint, pi = fakePi()) {
  Object.assign(process.env, endpoint.env);
  await openSuperAgentPiBridge(pi.api);
  return pi;
}

async function connected(overrides: Partial<PiBridgeHandler> = {}, options: Partial<Parameters<typeof openPiBridgeEndpoint>[0]> = {}) {
  const host = recordingHandler(overrides);
  const endpoint = await openEndpoint(host.handler, options);
  const pi = await loadExtension(endpoint);
  const connection = await endpoint.connection;
  return { ...host, endpoint, pi, connection };
}

function rawClient(endpoint: PiBridgeEndpoint): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(endpointPath(endpoint));
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
    cleanups.push(() => socket.destroy());
  });
}
/** The real listeners `openPiBridgeEndpoint` starts, in order: observed, not replaced. */
function observeListeners(): () => net.Server[] {
  const listen = vi.spyOn(net.Server.prototype, "listen");
  cleanups.push(() => listen.mockRestore());
  return () => listen.mock.contexts as net.Server[];
}
/** A later client's outcome. POSIX refuses at once; a Windows pipe client waits while the accepted instance is open. */
const laterClient = (endpoint: PiBridgeEndpoint) => rawClient(endpoint).then(() => "connected", (error: NodeJS.ErrnoException) => error.code ?? "error");
const isWindows = process.platform === "win32";
const hello = (token: string) => `${JSON.stringify({ v: 1, type: "request", id: randomUUID(), method: "hello", payload: { token, protocol: 1 } })}\n`;
const rejection = (promise: Promise<unknown>) => promise.then(() => { throw new Error("expected a rejection"); }, error => error);
const toolCall = (pi: ReturnType<typeof fakePi>, toolName: string, input: unknown = {}, signal?: AbortSignal) =>
  pi.handlers.get("tool_call")!({ toolName, toolCallId: `call-${toolName}`, input }, { signal });

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  const store = globalThis as unknown as Record<symbol, { socket?: net.Socket } | undefined>;
  const key = Symbol.for(PI_BRIDGE_GLOBAL_KEY);
  store[key]?.socket?.destroy();
  delete store[key];
  delete process.env[PI_BRIDGE_ENDPOINT_ENV];
  delete process.env[PI_BRIDGE_TOKEN_ENV];
});

describe("Pi bridge handshake", () => {
  it("accepts the extension, then closes the listener and removes the socket", async () => {
    const listeners = observeListeners();
    const { endpoint, connection, pi } = await connected();
    expect(connection.isOpen).toBe(true);
    expect(process.env[PI_BRIDGE_ENDPOINT_ENV]).toBeUndefined();
    expect(process.env[PI_BRIDGE_TOKEN_ENV]).toBeUndefined();
    const [listener] = listeners();
    expect(listeners()).toHaveLength(1);
    expect(listener!.listening).toBe(false);
    expect(existsSync(endpointPath(endpoint))).toBe(false);
    // POSIX: the private socket directory is removed as well. A Windows named pipe has no directory.
    if (!isWindows) expect(existsSync(path.dirname(endpointPath(endpoint)))).toBe(false);
    expect([...pi.handlers.keys()].sort()).toEqual(["before_agent_start", "model_select", "project_trust", "session_shutdown", "session_start", "tool_call", "user_bash"]);
    expect(pi.commands.has(PI_BRIDGE_COMMAND)).toBe(true);
    // Nobody can connect afterwards. A Windows pipe client waits for the accepted instance, so end it first there.
    const later = laterClient(endpoint);
    if (isWindows) connection.close();
    expect(await later).not.toBe("connected");
  });

  it("rejects a wrong token", async () => {
    const endpoint = await openEndpoint(recordingHandler().handler);
    const socket = await rawClient(endpoint);
    const closed = new Promise(resolve => socket.once("close", resolve));
    socket.write(hello("0".repeat(64)));
    const error = await rejection(endpoint.connection);
    expect(error).toBeInstanceOf(PiBridgeHandshakeError);
    expect(error.reason).toBe("token");
    await closed;
    expect(existsSync(endpointPath(endpoint))).toBe(false);
  });

  it("rejects a first frame that is not a hello", async () => {
    for (const first of ["{not json}\n", `${JSON.stringify({ v: 1, type: "request", id: randomUUID(), method: "approve", payload: {} })}\n`, `${"x".repeat(9000)}`]) {
      const endpoint = await openEndpoint(recordingHandler().handler);
      (await rawClient(endpoint)).write(first);
      expect((await rejection(endpoint.connection)).reason).toBe("malformed");
    }
  });

  it("times out when nothing authenticates", async () => {
    const silent = await openEndpoint(recordingHandler().handler, { handshakeTimeoutMs: 40 });
    expect((await rejection(silent.connection)).reason).toBe("timeout");
    expect(existsSync(endpointPath(silent))).toBe(false);

    const stalled = await openEndpoint(recordingHandler().handler, { handshakeTimeoutMs: 40 });
    const socket = await rawClient(stalled);
    const closed = new Promise(resolve => socket.once("close", resolve));
    expect((await rejection(stalled.connection)).reason).toBe("timeout");
    await closed;
  });

  it("serves only the first connection", async () => {
    const listeners = observeListeners();
    const endpoint = await openEndpoint(recordingHandler().handler);
    const [listener] = listeners();
    let accepted = 0;
    listener!.on("connection", () => { accepted++; });
    const token = endpoint.env[PI_BRIDGE_TOKEN_ENV]!;
    const first = await rawClient(endpoint);
    // The listener closes as soon as it accepts, before any handshake.
    await vi.waitFor(() => expect(listener!.listening).toBe(false));
    if (!isWindows) expect(existsSync(endpointPath(endpoint))).toBe(false); // POSIX: the socket file is gone too
    const second = laterClient(endpoint);
    first.write(hello(token));
    const connection = await endpoint.connection;
    expect(connection.isOpen).toBe(true);
    // Windows: the second client is still waiting for the pipe; once the only instance ends it fails instead of connecting.
    connection.close();
    expect(await second).not.toBe("connected");
    expect(accepted).toBe(1);
  });

  it("fails when the peer disconnects before authenticating", async () => {
    const endpoint = await openEndpoint(recordingHandler().handler);
    (await rawClient(endpoint)).destroy();
    expect((await rejection(endpoint.connection)).reason).toBe("closed");
  });

  it("dispose is idempotent and rejects a pending handshake", async () => {
    const endpoint = await openEndpoint(recordingHandler().handler);
    endpoint.dispose();
    endpoint.dispose();
    expect((await rejection(endpoint.connection)).reason).toBe("disposed");
    expect(existsSync(endpointPath(endpoint))).toBe(false);
  });

  it("an extension holding a wrong token stays closed and blocks tools", async () => {
    const host = recordingHandler();
    const endpoint = await openEndpoint(host.handler);
    const pi = fakePi();
    process.env[PI_BRIDGE_ENDPOINT_ENV] = endpointPath(endpoint);
    process.env[PI_BRIDGE_TOKEN_ENV] = "f".repeat(64);
    await openSuperAgentPiBridge(pi.api);
    expect((await rejection(endpoint.connection)).reason).toBe("token");
    expect(await toolCall(pi, "bash")).toMatchObject({ block: true });
    expect(host.approvals).toEqual([]);
  });

  it("does nothing when Pi was not started by the Host", async () => {
    const pi = fakePi();
    await openSuperAgentPiBridge(pi.api);
    expect(pi.handlers.size).toBe(0);
    expect(pi.commands.size).toBe(0);
    expect(pi.registrations).toEqual([]);
  });
});

describe("Pi bridge endpoint placement", () => {
  // The socket directory, its sun_path fallback and its private-directory check exist only in the POSIX branch.
  // Windows listens on a named pipe and creates no directory; the Windows test below covers that branch.
  it.runIf(isWindows)("uses a private named pipe on Windows and creates nothing under the state directory", async () => {
    const directory = await stateDir();
    const deep = path.join(directory, "a".repeat(60), "b".repeat(60));
    await mkdir(deep, { recursive: true });
    const listeners = observeListeners();
    const host = recordingHandler();
    const endpoint = await openEndpoint(host.handler, { stateDir: deep });
    expect(endpointPath(endpoint)).toMatch(/^\\\\\.\\pipe\\open-super-agent-pi-[0-9a-f]{32}$/);
    expect(endpoint.env[PI_BRIDGE_TOKEN_ENV]).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(path.join(deep, "pi"))).toBe(false);
    const pi = await loadExtension(endpoint);
    const connection = await endpoint.connection;
    expect(connection.isOpen).toBe(true);
    expect(listeners()[0]!.listening).toBe(false);
    expect(await toolCall(pi, "bash")).toBeUndefined(); // an approval round trip over the pipe
    expect(host.approvals.map(approval => approval.toolName)).toEqual(["bash"]);
    endpoint.dispose();
    await connection.closed;
    expect(existsSync(endpointPath(endpoint))).toBe(false);
    expect(existsSync(path.join(deep, "pi"))).toBe(false);
    expect(existsSync(path.join(directory, "pi"))).toBe(false);
  });

  it.skipIf(isWindows)("uses a private directory under the state directory when the path fits", async () => {
    const directory = await stateDir();
    const endpoint = await openEndpoint(recordingHandler().handler, { stateDir: directory });
    const socketPath = endpointPath(endpoint);
    expect(socketPath.startsWith(path.join(directory, "pi", "bridge") + path.sep)).toBe(true);
    expect(Buffer.byteLength(socketPath)).toBeLessThanOrEqual(PI_BRIDGE_UNIX_PATH_LIMIT);
    expect(endpoint.env[PI_BRIDGE_TOKEN_ENV]).toMatch(/^[0-9a-f]{64}$/);
  });

  it.skipIf(isWindows)("falls back to a short temporary directory for a long state path", async () => {
    const deep = path.join(await stateDir(), "a".repeat(60), "b".repeat(60));
    await mkdir(deep, { recursive: true });
    const endpoint = await openEndpoint(recordingHandler().handler, { stateDir: deep });
    const socketPath = endpointPath(endpoint);
    expect(socketPath.startsWith(deep)).toBe(false);
    expect(Buffer.byteLength(socketPath)).toBeLessThanOrEqual(PI_BRIDGE_UNIX_PATH_LIMIT);
    expect(existsSync(path.join(deep, "pi"))).toBe(false);
    endpoint.dispose();
    expect(existsSync(path.dirname(socketPath))).toBe(false);
  });

  it.skipIf(isWindows)("refuses a bridge directory that is not a real private directory", async () => {
    const directory = await stateDir();
    const elsewhere = await stateDir();
    await mkdir(path.join(directory, "pi"));
    const { symlink } = await import("node:fs/promises");
    await symlink(elsewhere, path.join(directory, "pi", "bridge"));
    await expect(openPiBridgeEndpoint({ stateDir: directory, handler: recordingHandler().handler })).rejects.toThrow(/private directory/);
  });

  it("plans a named pipe on Windows and a bounded socket path elsewhere", () => {
    const id = "0123456789abcdef0123456789abcdef";
    expect(planPiBridgeEndpoint({ stateDir: "C:\\state\\bot", platform: "win32", id })).toEqual({ kind: "pipe", endpoint: `\\\\.\\pipe\\open-super-agent-pi-${id}` });
    expect(planPiBridgeEndpoint({ stateDir: "/srv/state", platform: "linux", id })).toEqual({
      kind: "unix", directory: path.join("/srv/state", "pi", "bridge", "01234567"), endpoint: path.join("/srv/state", "pi", "bridge", "01234567", "s"), fits: true,
    });
    expect(planPiBridgeEndpoint({ stateDir: `/srv/${"x".repeat(100)}`, platform: "darwin", id })).toMatchObject({ kind: "unix", fits: false });
    expect(() => planPiBridgeEndpoint({ stateDir: "/srv/state", platform: "linux", id: "short" })).toThrow();
  });

  it("resolves the extension entry next to the host module", () => {
    const resolved = resolvePiBridgeExtensionPath();
    expect(path.basename(resolved)).toMatch(/^pi-bridge-extension\.(?:js|ts)$/);
    expect(existsSync(resolved)).toBe(true);
  });
});

describe("Pi bridge approval gate", () => {
  it("asks the Host, passes its decision on and can be opened", async () => {
    let decision: { allow: boolean; reason?: string } = { allow: true };
    const { pi, approvals, connection } = await connected({ approve: async input => { approvals.push(input); return decision; } });
    expect(await toolCall(pi, "bash", { command: "ls" })).toBeUndefined();
    expect(approvals).toEqual([{ toolName: "bash", toolCallId: "call-bash", origin: "builtin", input: { command: "ls" } }]);

    decision = { allow: false, reason: "Denied by the owner" };
    expect(await toolCall(pi, "write", { path: "a.txt" })).toEqual({ block: true, reason: "Denied by the owner" });

    await connection.setGate(false);
    expect(await toolCall(pi, "bash")).toBeUndefined();
    expect(approvals).toHaveLength(2);

    await connection.setGate(true);
    expect(await toolCall(pi, "bash")).toMatchObject({ block: true });
    expect(approvals).toHaveLength(3);
  });

  it("fails closed when the Host is gone, the handler throws or the answer is not a decision", async () => {
    const throwing = await connected({ approve: async () => { throw new Error("card unavailable"); } });
    expect(await toolCall(throwing.pi, "bash")).toMatchObject({ block: true });

    throwing.connection.close();
    await throwing.connection.closed;
    await vi.waitFor(async () => expect(await toolCall(throwing.pi, "bash")).toEqual({ block: true, reason: "open-super-agent approval is unavailable, so the tool was not run." }));
  });

  it("keeps an opened gate open after the Host disconnects", async () => {
    const { pi, connection } = await connected({}, { initial: { gate: false } });
    expect(await toolCall(pi, "bash")).toBeUndefined();
    connection.close();
    await connection.closed;
    expect(await toolCall(pi, "bash")).toBeUndefined();
  });

  it("releases a waiting approval when Pi aborts the run", async () => {
    let hostSignal: AbortSignal | undefined;
    const { pi } = await connected({ approve: (_input, signal) => new Promise(() => { hostSignal = signal; }) });
    const controller = new AbortController();
    const pending = toolCall(pi, "bash", {}, controller.signal);
    await vi.waitFor(() => expect(hostSignal).toBeDefined());
    controller.abort();
    expect(await pending).toEqual({ block: true, reason: "Cancelled before approval." });
    await vi.waitFor(() => expect(hostSignal!.aborted).toBe(true));
  });

  it("shortens an oversized input instead of dropping the request", async () => {
    const { pi, approvals } = await connected();
    expect(await toolCall(pi, "write", { path: "big.txt", content: "x".repeat(2 * 1024 * 1024) })).toBeUndefined();
    expect(approvals[0]!.inputTruncated).toBe(true);
    expect(JSON.stringify(approvals[0]!.input).length).toBeLessThan(300_000);
    expect((approvals[0]!.input as { path: string }).path).toBe("big.txt");
  });

  it("marks every item, field and preview it leaves out of an oversized approval, and runs the tool with its full input", async () => {
    const { pi, approvals } = await connected();
    const edits = Array.from({ length: 80 }, (_, index) => ({ oldText: `OLD-${index}-${"a".repeat(1990)}`, newText: `NEW-${index}-${"b".repeat(1990)}` }));
    const input = { path: "src/app.ts", edits };
    expect(await toolCall(pi, "edit", input)).toBeUndefined();
    const shown = approvals[0]!.input as { path: string; edits: unknown[] };
    expect(approvals[0]!.inputTruncated).toBe(true);
    expect(shown.edits).toHaveLength(51);
    expect(shown.edits.at(-1)).toBe("… [30 more items not shown]");
    expect(JSON.stringify(shown)).not.toContain("OLD-50-");
    expect(input.edits).toHaveLength(80); // the approval shows a copy; the tool's own arguments are untouched

    const fields = Object.fromEntries(Array.from({ length: 60 }, (_, index) => [`field${index}`, "x".repeat(5000)]));
    await toolCall(pi, "custom", { ...fields, "…": "own value" });
    const keys = approvals[1]!.input as Record<string, unknown>;
    expect(Object.keys(keys)).toHaveLength(52); // the leading notice, 50 fields and the omitted-fields mark
    expect(Object.keys(keys)[0]).toBe("⚠");
    expect(Object.values(keys).at(-1)).toBe("[11 more fields not shown]");

    await toolCall(pi, "custom", { rows: Array.from({ length: 50 }, () => Array.from({ length: 50 }, () => "y".repeat(400))) });
    const preview = approvals[2]!.input as { preview: string; notice: string };
    expect(preview.preview.length).toBe(8000);
    expect(preview.notice).toMatch(/too large to show in full \(\d+ bytes\); only its beginning is shown/);

    // The incomplete-preview notice leads every shortened preview, ahead of the bulk it shortens.
    for (const approval of approvals.slice(0, 3)) {
      const head = JSON.stringify(approval.input).slice(0, 200);
      expect(head).toContain("preview is shortened");
    }
    expect(Object.keys(preview)[0]).toBe("notice");

    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    await toolCall(pi, "custom", cyclic);
    expect(approvals[3]).toMatchObject({ input: { notice: "The tool input cannot be shown." }, inputTruncated: true });
  });
});

describe("Pi bridge tool origin", () => {
  const origins = async (host: Awaited<ReturnType<typeof connected>>, names: string[]) => {
    const from = host.approvals.length;
    for (const name of names) await toolCall(host.pi, name);
    return Object.fromEntries(host.approvals.slice(from).map(approval => [approval.toolName, approval.origin]));
  };

  it("reports builtin only for Pi's own tool under that name", async () => {
    const host = await connected();
    host.pi.foreign.set("codemode", { name: "codemode", description: "Scripts", exposure: "model-only", sourceInfo: builtinSource("codemode") });
    host.pi.foreign.set("tool_search", { name: "tool_search", description: "Search tools", exposure: "model-only", sourceInfo: builtinSource("tool-search") });
    host.pi.foreign.set("mcp__docs__search", { name: "mcp__docs__search", description: "Server tool", exposure: "direct", sourceInfo: builtinSource("mcp") });
    host.pi.foreign.set("list_mcp_resources", { name: "list_mcp_resources", description: "Resources", exposure: "direct", sourceInfo: builtinSource("mcp") });
    host.pi.foreign.set("todo", { name: "todo", description: "Extension tool", exposure: "direct", sourceInfo: extensionSource("/srv/extensions/todo.ts") });
    expect(await origins(host, ["bash", "grep", "codemode", "tool_search", "mcp__docs__search", "list_mcp_resources", "todo", "no_such_tool"])).toEqual({
      bash: "builtin", grep: "builtin", codemode: "builtin", tool_search: "builtin",
      mcp__docs__search: "other", list_mcp_resources: "other", todo: "other", no_such_tool: "other",
    });
  });

  it("reports other for an extension that took over a built-in name", async () => {
    const host = await connected();
    // What Pi's tool-override example does: `read` now runs extension code.
    host.pi.foreign.set("read", { name: "read", description: "Read, overridden", exposure: "direct", sourceInfo: extensionSource("/srv/extensions/tool-override.ts") });
    host.pi.foreign.set("grep", { name: "grep", description: "Search, replaced", exposure: "direct", sourceInfo: { path: "builtin:mcp", source: "builtin" } });
    host.pi.foreign.set("bash", { name: "bash", description: "No source", exposure: "direct" });
    expect(await origins(host, ["read", "grep", "bash"])).toEqual({ read: "other", grep: "other", bash: "other" });
    expect((await host.connection.listTools()).map(tool => [tool.name, tool.origin])).toEqual([["read", "other"], ["bash", "other"], ["grep", "other"]]);
  });

  it("fails closed when the registry cannot be read or lists a name twice", async () => {
    const host = await connected();
    host.pi.state.toolsReadable = false;
    expect(await origins(host, ["read"])).toEqual({ read: "other" });
    host.pi.state.toolsReadable = true;
    const twice = host.pi.api.getAllTools;
    host.pi.api.getAllTools = () => [...twice(), { name: "read", description: "Duplicate", exposure: "direct", sourceInfo: builtinSource("read") }];
    expect(await origins(host, ["read"])).toEqual({ read: "other" });
  });

  it("skips the Host only for an App tool whose registry entry is this extension's", async () => {
    const echo = { name: "app_echo", description: "Echo", inputSchema: { type: "object" } };
    const host = await connected({}, { initial: { tools: [echo] } });
    expect(await toolCall(host.pi, "app_echo")).toBeUndefined();
    expect(host.approvals).toEqual([]);
    expect((await host.connection.listTools()).find(tool => tool.name === "app_echo")).toMatchObject({ origin: "bridge", active: true });

    // An extension loaded earlier registers the same name: Pi keeps its tool, so ours no longer runs.
    host.pi.foreign.set("app_echo", { name: "app_echo", description: "Impostor", exposure: "direct", sourceInfo: extensionSource("/srv/extensions/impostor.ts") });
    expect(await origins(host, ["app_echo"])).toEqual({ app_echo: "other" });
  });

  it("does not treat its own tools as verified while its source path is unknown", async () => {
    const echo = { name: "app_echo", description: "Echo", inputSchema: { type: "object" } };
    const host = recordingHandler();
    const endpoint = await openEndpoint(host.handler, { initial: { tools: [echo] } });
    const pi = fakePi();
    pi.state.commandPath = undefined;
    await loadExtension(endpoint, pi);
    await endpoint.connection;
    await toolCall(pi, "app_echo");
    expect(host.approvals.map(approval => [approval.toolName, approval.origin])).toEqual([["app_echo", "other"]]);
  });
});

describe("Pi bridge MCP servers", () => {
  const search = { name: "open_super_agent_search", config: { command: "node", args: ["search-mcp.js"], exposure: "direct" } };

  it("registers, replaces and removes the Host's servers without touching others", async () => {
    const { pi, connection } = await connected();
    expect(await connection.setMcpServers([search])).toEqual(["open_super_agent_search"]);
    expect(pi.mcp.get("open_super_agent_search")).toEqual(search.config);

    const files = { name: "open_super_agent_files", config: { url: "http://localhost:9/mcp" } };
    expect(await connection.setMcpServers([files, { name: "broken", config: { exposure: "direct" } }])).toEqual(["open_super_agent_files"]);
    expect([...pi.mcp.keys()]).toEqual(["open_super_agent_files"]);
    expect(pi.mcpLog).toEqual(["+open_super_agent_search", "+open_super_agent_files", "-open_super_agent_search"]);

    expect(await connection.setMcpServers([])).toEqual([]);
    expect(pi.mcp.size).toBe(0);
    await expect(connection.setMcpServers([{ name: "bad name", config: { command: "node" } }])).rejects.toThrow();
  });

  it("registers the list again when the extension is loaded on a new API object", async () => {
    const { connection } = await connected();
    await connection.setMcpServers([search]);
    const second = fakePi();
    await openSuperAgentPiBridge(second.api);
    expect(second.mcp.get("open_super_agent_search")).toEqual(search.config);
    expect(await connection.setMcpServers([])).toEqual([]);
    expect(second.mcpLog).toEqual(["+open_super_agent_search", "-open_super_agent_search"]);
  });

  it("escapes literal env and header values for Pi's config templates", () => {
    expect(escapePiConfigLiteral("plain")).toBe("plain");
    expect(escapePiConfigLiteral("a$b${c}")).toBe("a$$b$${c}");
    expect(escapePiConfigLiteral("!not-a-command")).toBe("$!not-a-command");
    expect(escapePiConfigLiteral("$!x")).toBe("$$!x");
  });
});

describe("Pi bridge App tools", () => {
  const echo = { name: "app_echo", description: "Echo through the App", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } };

  it("installs, calls, replaces and retires tools", async () => {
    const { pi, calls, approvals, connection } = await connected();
    expect(await connection.installTools([echo])).toEqual({ installed: ["app_echo"], skipped: [] });
    expect(pi.tools.get("app_echo")).toMatchObject({ label: "app_echo", description: echo.description, parameters: echo.inputSchema });
    expect(pi.active()).toContain("app_echo");

    expect(await pi.tools.get("app_echo")!.execute("call-1", { text: "hi" })).toEqual({ content: [{ type: "text", text: 'echo:{"text":"hi"}' }], details: {} });
    expect(calls).toEqual([{ name: "app_echo", callId: "call-1", arguments: { text: "hi" } }]);
    expect(await toolCall(pi, "app_echo")).toBeUndefined();
    expect(approvals).toEqual([]);

    await connection.installTools([echo]);
    expect(pi.registrations).toEqual(["app_echo"]);
    await connection.installTools([{ ...echo, description: "Echo, revised" }]);
    expect(pi.registrations).toEqual(["app_echo", "app_echo"]);
    expect(pi.tools.get("app_echo")!.description).toBe("Echo, revised");

    expect(await connection.installTools([])).toEqual({ installed: [], skipped: [] });
    expect(pi.active()).not.toContain("app_echo");
    expect(await pi.tools.get("app_echo")!.execute("call-2", { text: "late" })).toMatchObject({ isError: true });
    expect(calls).toHaveLength(1);
    // A retired App tool is an ordinary tool again: it goes through the gate.
    await toolCall(pi, "app_echo");
    expect(approvals).toHaveLength(1);

    await connection.installTools([echo]);
    expect(pi.active()).toContain("app_echo");
  });

  it("registers the initial tools before startup finishes and never shadows a foreign tool", async () => {
    const { pi, connection } = await connected({}, { initial: { tools: [echo] } });
    expect(pi.registrations).toEqual(["app_echo"]);
    expect(await connection.installTools([echo, { name: "read", description: "shadow", inputSchema: { type: "object" } }, { name: "bad name", description: "x", inputSchema: {} }]))
      .toEqual({ installed: ["app_echo"], skipped: ["read", "bad name"] });
    expect(pi.tools.has("read")).toBe(false);
  });

  it("returns an error result when the Host cannot answer", async () => {
    const { pi, connection } = await connected({ callTool: async () => { throw new Error("upload failed"); } }, { initial: { tools: [echo] } });
    expect(await pi.tools.get("app_echo")!.execute("call-1", { text: "x" })).toMatchObject({ isError: true });
    expect(await pi.tools.get("app_echo")!.execute("call-2", { text: "y".repeat(2 * 1024 * 1024) })).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("size limit") }] });
    connection.close();
    await connection.closed;
    await vi.waitFor(async () => expect(await pi.tools.get("app_echo")!.execute("call-3", { text: "z" })).toMatchObject({ isError: true }));
  });

  it("lists and switches tools, sets labels and reads settings", async () => {
    const { pi, connection } = await connected();
    expect(await connection.listTools()).toEqual([
      { name: "read", active: true, origin: "builtin", exposure: "direct", description: "Read a file" },
      { name: "bash", active: true, origin: "builtin", exposure: "direct", description: "Run a command" },
      { name: "grep", active: false, origin: "builtin", exposure: "direct", description: "Search" },
    ]);
    expect((await connection.setActiveTools(["read", "grep"])).filter(tool => tool.active).map(tool => tool.name)).toEqual(["read", "grep"]);
    await connection.setLabel("entry-1", "checkpoint");
    await connection.setLabel("entry-1", null);
    expect(pi.labels).toEqual([["entry-1", "checkpoint"], ["entry-1", undefined]]);
    expect(await connection.readSettings()).toEqual({ defaultProvider: "synthetic", compaction: { enabled: true } });
  });
});

describe("Pi bridge trust, instructions and events", () => {
  it("relays the trust decision without asking Pi to remember it", async () => {
    let answer: "yes" | "no" | "undecided" = "yes";
    const seen: string[] = [];
    const { pi } = await connected({ trust: async ({ cwd }) => { seen.push(cwd); if (cwd === "/throw") throw new Error("store unreadable"); return answer; } });
    const trust = pi.handlers.get("project_trust")!;
    expect(await trust({ type: "project_trust", cwd: "/srv/project" }, {})).toEqual({ trusted: "yes", remember: false });
    answer = "no";
    expect(await trust({ cwd: "/srv/project" }, {})).toEqual({ trusted: "no", remember: false });
    expect(await trust({ cwd: "/throw" }, {})).toEqual({ trusted: "undecided", remember: false });
    expect(seen).toEqual(["/srv/project", "/srv/project", "/throw"]);
  });

  it("appends Host instructions only when there are any", async () => {
    let instructions: string | undefined = "HOST-MARKER";
    const { pi } = await connected({ instructions: async () => instructions });
    const before = pi.handlers.get("before_agent_start")!;
    expect(await before({ systemPrompt: "base", prompt: "hi" }, {})).toEqual({ systemPrompt: "base\n\nHOST-MARKER" });
    instructions = "  ";
    expect(await before({ systemPrompt: "base" }, {})).toBeUndefined();
    instructions = undefined;
    expect(await before({ systemPrompt: "base" }, {})).toBeUndefined();
  });

  it("delivers lifecycle events and drops malformed ones", async () => {
    const { pi, events } = await connected();
    pi.handlers.get("session_start")!({ reason: "startup" }, { isProjectTrusted: () => false });
    pi.handlers.get("model_select")!({ model: { provider: "fakeprov", id: "dup-model" }, source: "set" }, {});
    pi.handlers.get("model_select")!({ model: { provider: 7 } }, {});
    expect(pi.handlers.get("user_bash")!({ command: "echo hi" }, {})).toBeUndefined();
    pi.handlers.get("session_shutdown")!({ reason: "reload" }, {});
    await vi.waitFor(() => expect(events).toEqual([
      { type: "session_start", reason: "startup", trusted: false },
      { type: "model_select", provider: "fakeprov", modelId: "dup-model", source: "set" },
      { type: "user_bash", command: "echo hi" },
      { type: "session_shutdown", reason: "reload" },
    ]));
  });
});

describe("Pi bridge control", () => {
  /** Stands in for Pi executing the prompt text as an extension command. */
  const runCommand = (pi: ReturnType<typeof fakePi>, ctx: Record<string, unknown>) => async (text: string) => {
    const [command, id] = text.split(" ");
    expect(command).toBe(`/${PI_BRIDGE_COMMAND}`);
    await pi.commands.get(PI_BRIDGE_COMMAND)!.handler(id!, ctx);
    return "handled" as const;
  };

  it("runs a claimed request once and ignores ids the Host did not issue", async () => {
    const { pi, connection } = await connected();
    const navigate = vi.fn(async () => ({ cancelled: false }));
    const reload = vi.fn(async () => {});
    const fork = vi.fn(async () => ({ cancelled: true }));
    const ctx = { navigateTree: navigate, reload, fork };
    let issued = "";
    const trigger = async (text: string) => { issued = text.split(" ")[1]!; return runCommand(pi, ctx)(text); };

    expect(await connection.control({ op: "navigate", targetId: "entry-7", summarize: true, label: "before refactor" }, { trigger })).toEqual({ cancelled: false });
    expect(navigate).toHaveBeenCalledWith("entry-7", { summarize: true, label: "before refactor" });
    expect(await connection.control({ op: "reload" }, { trigger })).toEqual({});
    expect(reload).toHaveBeenCalledTimes(1);
    expect(await connection.control({ op: "fork-at", entryId: "entry-9", position: "at" }, { trigger })).toEqual({ cancelled: true });
    expect(fork).toHaveBeenCalledWith("entry-9", { position: "at" });

    // Replaying a used id, an unknown id or free text reaches nothing.
    const command = pi.commands.get(PI_BRIDGE_COMMAND)!;
    await command.handler(issued, ctx);
    await command.handler(randomUUID(), ctx);
    await command.handler("navigate entry-7", ctx);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(fork).toHaveBeenCalledTimes(1);
  });

  it("reports a native refusal, a failed trigger and an unhandled prompt", async () => {
    const { pi, connection } = await connected();
    const refused = await rejection(connection.control({ op: "navigate", targetId: "entry-1" }, {
      trigger: runCommand(pi, { navigateTree: async () => { throw new Error("Cannot navigate while streaming"); } }),
    }));
    expect(refused).toBeInstanceOf(PiBridgeControlError);
    expect(refused).toMatchObject({ reason: "failed", message: "Cannot navigate while streaming" });

    expect(await rejection(connection.control({ op: "reload" }, { trigger: async () => { throw new Error("Pi exited"); } }))).toMatchObject({ message: "Pi exited" });
    expect(await rejection(connection.control({ op: "reload" }, { trigger: async () => "started" }))).toMatchObject({ reason: "not-handled" });
    expect(await rejection(connection.control({ op: "reload" }, { trigger: () => new Promise(() => {}), timeoutMs: 30 }))).toMatchObject({ reason: "timeout" });

    const controller = new AbortController();
    const aborted = rejection(connection.control({ op: "reload" }, { trigger: () => new Promise(() => {}), signal: controller.signal }));
    controller.abort();
    expect(await aborted).toMatchObject({ reason: "aborted" });
  });

  it("rejects pending controls when the bridge closes", async () => {
    const { connection } = await connected();
    const pending = rejection(connection.control({ op: "reload" }, { trigger: () => new Promise(() => {}) }));
    connection.close();
    expect(await pending).toMatchObject({ reason: "closed" });
    expect(await rejection(connection.control({ op: "reload" }, { trigger: async () => {} }))).toMatchObject({ reason: "closed" });
  });
});

describe("Pi bridge reload", () => {
  it("reuses the one connection and re-registers on the new extension API", async () => {
    const echo = { name: "app_echo", description: "Echo", inputSchema: { type: "object" } };
    const { endpoint, pi: first, connection, approvals, calls } = await connected();
    await connection.installTools([echo]);
    let connections = 0;
    void endpoint.connection.then(() => { connections++; });

    const second = fakePi();
    await openSuperAgentPiBridge(second.api);
    expect(connections).toBe(1);
    expect(connection.isOpen).toBe(true);
    expect(second.handlers.size).toBe(first.handlers.size);
    expect(second.commands.has(PI_BRIDGE_COMMAND)).toBe(true);
    expect(second.registrations).toEqual(["app_echo"]);

    expect(await toolCall(second, "bash")).toBeUndefined();
    expect(approvals).toHaveLength(1);
    await second.tools.get("app_echo")!.execute("call-1", { text: "after reload" });
    expect(calls).toEqual([{ name: "app_echo", callId: "call-1", arguments: { text: "after reload" } }]);
    // Host requests now reach the new API object.
    await connection.setLabel("entry-2", "after");
    expect(second.labels).toEqual([["entry-2", "after"]]);
    expect(first.labels).toEqual([]);
  });
});

describe("Pi bridge connection typing", () => {
  it("exposes the connection contract", async () => {
    const { connection } = await connected();
    const contract: PiBridgeConnection = connection;
    expect(typeof contract.control).toBe("function");
    contract.close();
    await contract.closed;
    expect(contract.isOpen).toBe(false);
  });
});
