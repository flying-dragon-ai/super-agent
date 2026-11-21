import type { ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PiRpcClient, PiRpcClosedError, PiRpcCommandError, PiRpcTimeoutError, PiStartupError, queryPiCatalog,
  type PiRpcClientOptions, type PiSpawn,
} from "../src/codex/pi-rpc-client.js";
import type { PiExtensionUiRequest, PiSessionEvent } from "../src/codex/pi-rpc-protocol.js";
import { FAKE_PI_PLACEHOLDER_MODEL, FakePiProcess, fakePiModel, fakePiSpawner, type FakePiOptions } from "./helpers/pi-fake-rpc.js";

type Command = { id?: string; type: string; [key: string]: unknown };

const launch = { command: "pi", args: ["cli.js"] };

function harness(options: FakePiOptions | ((index: number, args: string[]) => FakePiOptions) = {}) {
  const spawner = fakePiSpawner(options);
  const treeKills: Array<number | undefined> = [];
  /** Stands in for the process-tree killer: nothing survives it. */
  const killProcessTreeFn = (pid: number | undefined) => { treeKills.push(pid); for (const process of spawner.processes) process.kill("SIGKILL"); };
  const base = { launch, cwd: "/synthetic/workspace", env: { PI_MARK: "1" } as NodeJS.ProcessEnv, spawnFn: spawner.spawn, killProcessTreeFn };
  const start = (extra: Partial<PiRpcClientOptions> = {}) => PiRpcClient.start({ ...base, ...extra });
  live.push(spawner.processes);
  return { spawner, treeKills, base, start };
}

const live: FakePiProcess[][] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const processes of live.splice(0)) for (const process of processes) { process.stubborn = false; process.kill("SIGKILL"); }
});

async function waitFor(condition: () => boolean, label = "condition"): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise(resolve => setImmediate(resolve));
  }
}
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
const caught = async (promise: Promise<unknown>): Promise<unknown> => promise.then(() => { throw new Error("expected a rejection"); }, error => error);
const stateOf = (process: FakePiProcess) => ({ ...process.state, messageCount: 0, pendingMessageCount: 0 });

/** Hold back every command after the handshake so the test decides when and how each is answered. */
function holding(): { options: FakePiOptions; held: Command[]; release(): void } {
  const held: Command[] = [];
  let hold = false, first = true;
  return {
    held,
    release: () => { hold = false; },
    options: {
      onCommand: command => {
        if (first) { first = false; hold = true; return; } // let the handshake through
        if (!hold) return;
        held.push(command);
        return true;
      },
    },
  };
}

describe("PiRpcClient startup", () => {
  it("spawns Pi in RPC mode with the given arguments and waits for get_state", async () => {
    const { spawner, start } = harness();
    const client = await start({ args: ["--session-dir", "/synthetic/sessions", "--session-id", "abc"] });
    const process = spawner.last();
    expect(process.spawnArgs.command).toBe("pi");
    expect(process.args).toEqual(["cli.js", "--mode", "rpc", "--session-dir", "/synthetic/sessions", "--session-id", "abc"]);
    expect(process.spawnArgs.options).toMatchObject({ cwd: "/synthetic/workspace", env: { PI_MARK: "1" }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    expect(process.received).toEqual([{ id: "tb-1", type: "get_state" }]);
    expect(client.pid).toBe(4242);
    expect(client.isAlive).toBe(true);
    expect(client.receivedFrames).toBe(1);
  });

  // On Windows the platform search for a bare name looks in the child's working directory (the
  // workspace) first; a relative PATH entry does the same on every platform. Pi is launched only
  // from a resolved absolute file, and a bare name that resolves to none fails without a spawn.
  it.skipIf(process.platform === "win32")("never runs a same-named file from the workspace for a bare command", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "open-super-agent-pi-shadow-"));
    try {
      const workspace = path.join(root, "workspace"), marker = path.join(root, "ran");
      await mkdir(workspace);
      await writeFile(path.join(workspace, "pi-lab-shadow"), `#!/bin/sh\necho ran > "${marker}"\n`, { mode: 0o755 });
      const error = await caught(PiRpcClient.start({ launch: { command: "pi-lab-shadow", args: [] }, cwd: workspace, env: { PATH: "." }, startupTimeoutMs: 2_000 }));
      expect(error).toMatchObject({ name: "PiStartupError", reason: "spawn", message: "Pi executable was not found" });
      await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("reports a spawn function that throws", async () => {
    const spawnFn: PiSpawn = () => { throw new Error("spawn EACCES"); };
    const error = await caught(PiRpcClient.start({ launch, cwd: "/synthetic/workspace", env: {}, spawnFn }));
    expect(error).toBeInstanceOf(PiStartupError);
    expect(error).toMatchObject({ name: "PiStartupError", reason: "spawn", message: "Pi could not be started: spawn EACCES" });
  });

  it.each([
    ["ENOENT", "Pi executable was not found"],
    ["EACCES", "Pi could not be started (EACCES)"],
    [undefined, "Pi could not be started"],
  ])("reports an asynchronous spawn error (%s) as a spawn failure", async (code, message) => {
    const { spawner, base } = harness({ silent: true });
    const spawnFn: PiSpawn = (command, args, options) => {
      const child = spawner.spawn(command, args, options);
      // Node reports a missing executable through `error`; `close` may never follow.
      queueMicrotask(() => child.emit("error", Object.assign(new Error(`spawn pi ${code ?? "failed"}`), code ? { code } : {})));
      return child;
    };
    const error = await caught(PiRpcClient.start({ ...base, spawnFn }));
    expect(error).toMatchObject({ name: "PiStartupError", reason: "spawn", message });
  });

  it("reports a non-zero exit with a sanitized stderr detail", async () => {
    const { start } = harness({ exitAtStart: { code: 1, stderr: "Error: Failed to load extension at /synthetic/accounts/someone/ext/index.ts\n" } });
    const error = await caught(start()) as PiStartupError;
    expect(error).toBeInstanceOf(PiStartupError);
    expect(error.reason).toBe("exit");
    expect(error.exit).toMatchObject({ code: 1, signal: null, expected: false });
    expect(error.message).toBe("Pi exited during startup (code 1): Error: Failed to load extension at …/index.ts");
    expect(error.message).not.toContain("someone");
    expect(error.exit!.stderrTail).not.toContain("someone");
  });

  it("recognises exit 0 with no record, which is Pi asking a question on the terminal", async () => {
    // Observed with `--session <id>` from another directory: the first command is read as the answer.
    const { start, spawner } = harness({ exitAtStart: { code: 0, stderr: "Session found in different project: /synthetic/lab/proj\nFork this session into current directory? [y/N] Aborted.\n" } });
    const error = await caught(start()) as PiStartupError;
    expect(error).toMatchObject({ name: "PiStartupError", reason: "exit" });
    expect(error.exit).toMatchObject({ code: 0, expected: false });
    expect(error.message).toContain("code 0");
    expect(error.message).toContain("Fork this session into current directory? [y/N] Aborted.");
    expect(error.message).not.toContain("/synthetic/lab");
    expect(spawner.last().exitCode).toBe(0);
  });

  it("gives up on a process that never answers and stops it", async () => {
    const { start, treeKills, spawner } = harness({ silent: true });
    const started = Date.now();
    const error = await caught(start({ startupTimeoutMs: 40 }));
    expect(error).toMatchObject({ name: "PiStartupError", reason: "timeout", message: "Pi did not become ready within 40 ms" });
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(treeKills).toEqual([4242]);
    expect(spawner.last().stdin.destroyed).toBe(true);
  });

  it("stops and rejects with the caller's reason when the signal aborts during startup", async () => {
    const { start, treeKills } = harness({ silent: true });
    const controller = new AbortController(), reason = new Error("owner stopped the turn");
    const pending = caught(start({ signal: controller.signal, startupTimeoutMs: 5_000 }));
    setTimeout(() => controller.abort(reason), 10);
    expect(await pending).toBe(reason);
    expect(treeKills).toEqual([4242]);
  });

  it("reports a handshake Pi answers with an error as a protocol failure", async () => {
    const { start, treeKills } = harness({ onCommand: (command, process) => { process.fail(command, "boom"); return true; } });
    const error = await caught(start());
    expect(error).toMatchObject({ name: "PiStartupError", reason: "protocol", message: "Pi startup failed: boom" });
    expect(treeKills).toEqual([4242]);
  });

  it("delivers extension dialogs and events that arrive before the handshake answer", async () => {
    const seenUi: string[] = [], seenEvents: string[] = [];
    let first = true;
    const { start } = harness({
      onCommand: (command, process) => {
        if (!first) return;
        first = false;
        process.ui({ id: "early", method: "select", title: "Startup question", options: ["a"] });
        process.send({ type: "queue_update", steering: [], followUp: [] });
        process.respond(command, stateOf(process));
        return true;
      },
    });
    const client = await start({
      onExtensionUi: (request, peer) => { seenUi.push(request.id); expect(peer).toBeInstanceOf(PiRpcClient); },
      onEvent: event => { seenEvents.push(event.type); },
    });
    expect(seenUi).toEqual(["early"]);
    expect(seenEvents).toEqual(["queue_update"]);
    expect(client.receivedFrames).toBe(3);
  });
});

describe("PiRpcClient requests", () => {
  it.each(["abort", "timeout"] as const)("does not send a %s request still waiting behind backpressure", async mode => {
    const { spawner, start } = harness();
    const client = await start(), process = spawner.last();
    const write = process.stdin.write.bind(process.stdin);
    let drain!: () => void;
    vi.spyOn(process.stdin, "write").mockImplementationOnce(((line: string, callback: (error?: Error | null) => void) => {
      return write(line, error => { drain = () => callback(error); });
    }) as typeof process.stdin.write);
    await client.request({ type: "get_commands" });
    await waitFor(() => Boolean(drain));
    const controller = new AbortController(), reason = new Error("cancelled while waiting to write");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = caught(client.request({ type: "set_thinking_level", level: "high" }, {
      signal: controller.signal, timeoutMs: 100,
    }));
    if (mode === "abort") controller.abort(reason);
    else await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toMatchObject(mode === "abort" ? { message: reason.message } : { name: "PiRpcTimeoutError" });
    drain();
    vi.useRealTimers();
    expect((await client.request({ type: "get_state" })).thinkingLevel).toBe("medium");
    expect(process.received.map(command => command.type)).toEqual(["get_state", "get_commands", "get_state"]);
  });

  it("does not spawn a worker when startup was already cancelled", async () => {
    const { start, spawner } = harness();
    const controller = new AbortController(), reason = new Error("cancelled before startup");
    controller.abort(reason);
    expect(await caught(start({ signal: controller.signal }))).toBe(reason);
    expect(spawner.processes).toHaveLength(0);
  });

  it("correlates responses by id, whatever order they arrive in", async () => {
    const { options, held } = holding();
    const { spawner, start } = harness(options);
    const client = await start();
    const process = spawner.last();
    const stats = client.request({ type: "get_session_stats" });
    const commands = client.request({ type: "get_commands" });
    const models = client.request({ type: "get_available_models" });
    await waitFor(() => held.length === 3, "three held commands");
    expect(held.map(command => command.id)).toEqual(["tb-2", "tb-3", "tb-4"]);
    // Noise first: an unknown id, the id-less parse error, a record that is not JSON.
    process.send({ id: "tb-999", type: "response", command: "get_state", success: true, data: {} });
    process.send({ type: "response", command: "parse", success: false, error: "Failed to parse command: x" });
    process.sendRaw("this is not a record\n");
    process.respond(held[2]!, { models: [{ id: "m" }] });
    process.respond(held[0]!, { sessionId: "s", userMessages: 3 });
    process.respond(held[1]!, { commands: [] });
    expect(await models).toEqual({ models: [{ id: "m" }] });
    expect(await stats).toMatchObject({ userMessages: 3 });
    expect(await commands).toEqual({ commands: [] });
  });

  it("resolves a data-less success with undefined", async () => {
    const { start } = harness();
    const client = await start();
    expect(await client.request({ type: "set_thinking_level", level: "low" })).toBeUndefined();
    expect(await client.request({ type: "abort" })).toBeUndefined();
  });

  it("turns success:false into a PiRpcCommandError with a classified, sanitized message", async () => {
    const { start } = harness();
    const client = await start();
    const unknown = await caught(client.request({ type: "set_model", provider: "nowhere", modelId: "nothing" })) as PiRpcCommandError;
    expect(unknown).toBeInstanceOf(PiRpcCommandError);
    expect(unknown).toMatchObject({ name: "PiRpcCommandError", command: "set_model", kind: "model-unavailable", message: "Model not found: nowhere/nothing" });
    const empty = await caught(client.request({ type: "set_session_name", name: "  " })) as PiRpcCommandError;
    expect(empty).toMatchObject({ command: "set_session_name", kind: "other", message: "Session name cannot be empty" });
  });

  it("removes local paths and terminal advice from Pi's no-model error", async () => {
    const { start } = harness({ models: [] });
    const client = await start();
    const error = await caught(client.request({ type: "prompt", message: "hello" })) as PiRpcCommandError;
    expect(error).toMatchObject({ command: "prompt", kind: "no-model", message: "No API key found for the selected model." });
    expect(error.message).not.toContain("/synthetic");
    expect(error.message).not.toContain("/login");
  });

  it("falls back to a generic message when Pi gives no usable error text", async () => {
    const { options, held } = holding();
    const { spawner, start } = harness(options);
    const client = await start();
    const process = spawner.last();
    const silent = caught(client.request({ type: "get_commands" }));
    const pathOnly = caught(client.request({ type: "get_tree" }));
    await waitFor(() => held.length === 2);
    process.send({ id: held[0]!.id, type: "response", command: "get_commands", success: false });
    process.fail(held[1]!, "/synthetic/accounts/someone/secret/file.txt");
    expect(await silent).toMatchObject({ name: "PiRpcCommandError", kind: "other", message: "Pi rejected the command" });
    expect(await pathOnly).toMatchObject({ name: "PiRpcCommandError", message: "Pi rejected the command" });
  });

  it("gives quick commands a default deadline and commands that wait on a model or a person none", async () => {
    const { options, held } = holding();
    const { start } = harness(options);
    const client = await start();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const quick = caught(client.request({ type: "get_session_stats" }));
    const unbounded = ["prompt", "steer", "follow_up", "abort", "compact", "bash", "new_session", "switch_session", "fork", "clone", "export_html"] as const;
    let settled = 0;
    const count = () => { settled++; };
    void client.request({ type: "prompt", message: "x" }).then(count, count);
    void client.request({ type: "steer", message: "x" }).then(count, count);
    void client.request({ type: "follow_up", message: "x" }).then(count, count);
    void client.request({ type: "abort" }).then(count, count);
    void client.request({ type: "compact" }).then(count, count);
    void client.request({ type: "bash", command: "sleep 1" }).then(count, count);
    void client.request({ type: "new_session" }).then(count, count);
    void client.request({ type: "switch_session", sessionPath: "/synthetic/s.jsonl" }).then(count, count);
    void client.request({ type: "fork", entryId: "e1" }).then(count, count);
    void client.request({ type: "clone" }).then(count, count);
    void client.request({ type: "export_html" }).then(count, count);
    let quickDone = false;
    void quick.then(() => { quickDone = true; });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(quickDone).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    const error = await quick as PiRpcTimeoutError;
    expect(error).toBeInstanceOf(PiRpcTimeoutError);
    expect(error).toMatchObject({ name: "PiRpcTimeoutError", command: "get_session_stats", timeoutMs: 30_000 });
    await vi.advanceTimersByTimeAsync(6 * 60 * 60_000);
    expect(settled).toBe(0);
    expect(held.map(command => command.type)).toEqual(["get_session_stats", ...unbounded]);
  });

  it("honours an explicit deadline, ignores the late answer, and stays usable", async () => {
    const { options, held, release } = holding();
    const { spawner, start } = harness(options);
    const client = await start();
    const error = await caught(client.request({ type: "prompt", message: "slow" }, { timeoutMs: 25 }));
    expect(error).toMatchObject({ name: "PiRpcTimeoutError", command: "prompt", timeoutMs: 25 });
    spawner.last().respond(held[0]!, { disposition: "started" }); // nobody is waiting any more
    release();
    expect(await client.request({ type: "get_available_thinking_levels" })).toEqual({ levels: ["off", "minimal", "low", "medium", "high"] });
  });

  it("rejects with the abort reason, before or after the command was sent", async () => {
    const { options, held, release } = holding();
    const { spawner, start } = harness(options);
    const client = await start();
    const process = spawner.last();

    const already = new AbortController(), reason = new Error("stop now");
    already.abort(reason);
    expect(await caught(client.request({ type: "get_commands" }, { signal: already.signal }))).toBe(reason);
    expect(process.received.map(command => command.type)).toEqual(["get_state"]); // nothing was written

    const later = new AbortController();
    const pending = caught(client.request({ type: "prompt", message: "x" }, { signal: later.signal }));
    await waitFor(() => held.length === 1);
    later.abort();
    expect(await pending).toMatchObject({ name: "AbortError" });

    const plain = new AbortController();
    const withString = caught(client.request({ type: "get_tree" }, { signal: plain.signal }));
    await waitFor(() => held.length === 2);
    plain.abort("just a string");
    expect(await withString).toMatchObject({ message: "Aborted" });

    process.respond(held[0]!, { disposition: "started" }); // late answers to aborted requests are dropped
    process.respond(held[1]!, { tree: [], leafId: null });
    release();
    expect(await client.request({ type: "get_messages" })).toEqual({ messages: [] });
  });

  it("keeps the order of writes, a multi-megabyte prompt included", async () => {
    const { spawner, start } = harness({ onPrompt: run => { run.reply("ok"); run.finish(); } });
    const client = await start();
    const big = `${"图".repeat(1_000_000)}${"x".repeat(3_000_000)} end`;
    const results = await Promise.all([
      client.request({ type: "prompt", message: big, images: [{ type: "image", data: "A".repeat(2_000_000), mimeType: "image/png" }] }),
      client.request({ type: "get_session_stats" }),
      client.request({ type: "get_commands" }),
    ]);
    expect(results[0]).toEqual({ disposition: "started" });
    const received = spawner.last().received;
    expect(received.map(command => command.type)).toEqual(["get_state", "prompt", "get_session_stats", "get_commands"]);
    expect(received[1]!.message).toBe(big);
    expect((received[1]!.images as Array<{ data: string }>)[0]!.data).toHaveLength(2_000_000);
  });
});

describe("PiRpcClient events and extension UI", () => {
  it("delivers session events and extension UI records to their listeners", async () => {
    const { spawner, start } = harness();
    const client = await start();
    const process = spawner.last();
    const events: PiSessionEvent[] = [], ui: PiExtensionUiRequest[] = [];
    const offEvents = client.onEvent(event => { events.push(event); });
    client.onExtensionUi(request => { ui.push(request); });
    process.send({ type: "agent_start" });
    process.send({ type: "brand_new_event", value: 1 });
    process.ui({ id: "u1", method: "notify", message: "hello", notifyType: "warning" });
    process.ui({ id: "u2", method: "confirm", title: "Sure?" });
    process.send({ type: "agent_settled", aborted: false });
    await waitFor(() => events.length === 3 && ui.length === 2);
    expect(events).toEqual([
      { type: "agent_start" },
      { type: "unknown", originalType: "brand_new_event", raw: { type: "brand_new_event", value: 1 } },
      { type: "agent_settled", aborted: false },
    ]);
    expect(ui.map(request => [request.id, request.method])).toEqual([["u1", "notify"], ["u2", "confirm"]]);
    expect(ui[1]).toMatchObject({ message: "" });
    offEvents();
    process.send({ type: "turn_start" });
    process.ui({ id: "u3", method: "setTitle", title: "t" });
    await waitFor(() => ui.length === 3);
    expect(events).toHaveLength(3);
  });

  it("does not let a throwing listener break the stream or the other listeners", async () => {
    const { spawner, start } = harness();
    const client = await start();
    const process = spawner.last();
    const seen: string[] = [];
    client.onEvent(() => { throw new Error("listener bug"); });
    client.onEvent(event => { seen.push(event.type); });
    client.onExtensionUi(() => { throw new Error("ui listener bug"); });
    client.onExtensionUi(request => { seen.push(`ui:${request.method}`); });
    process.send({ type: "agent_start" });
    process.ui({ id: "u1", method: "notify", message: "hello" });
    process.send({ type: "agent_settled", aborted: false });
    await waitFor(() => seen.length === 3);
    expect(seen).toEqual(["agent_start", "ui:notify", "agent_settled"]);
    expect(await client.request({ type: "get_messages" })).toEqual({ messages: [] });
  });

  it("writes dialog answers as extension_ui_response records", async () => {
    const { spawner, start } = harness();
    const client = await start();
    const process = spawner.last();
    client.respondExtensionUi({ type: "extension_ui_response", id: "d1", value: "A B" });
    client.respondExtensionUi({ type: "extension_ui_response", id: "d2", confirmed: false });
    client.respondExtensionUi({ type: "extension_ui_response", id: "d3", cancelled: true });
    await waitFor(() => process.uiResponses.length === 3);
    expect(process.uiResponses).toEqual([
      { type: "extension_ui_response", id: "d1", value: "A B" },
      { type: "extension_ui_response", id: "d2", confirmed: false },
      { type: "extension_ui_response", id: "d3", cancelled: true },
    ]);
    // A dialog answer is not a command: it gets no id and no response.
    expect(process.received.map(command => command.type)).toEqual(["get_state"]);
  });

  it("counts only valid records and ignores malformed ones", async () => {
    const { spawner, start } = harness();
    const client = await start();
    const process = spawner.last();
    const before = client.receivedFrames;
    process.sendRaw("garbage\n\n{\"type\":\"agent_settled\"}\n{\"type\":\"response\",\"success\":true}\r\n");
    process.send({ type: "turn_start" });
    const events: string[] = [];
    client.onEvent(event => { events.push(event.type); });
    process.send({ type: "agent_start" });
    await waitFor(() => events.includes("agent_start"));
    expect(client.receivedFrames - before).toBe(2);
  });

  it("splits records on LF only and reassembles records that arrive in pieces", async () => {
    const { spawner, start } = harness();
    const client = await start();
    const process = spawner.last();
    const events: PiSessionEvent[] = [];
    client.onEvent(event => { events.push(event); });
    const record = JSON.stringify({ type: "bash_execution_update", delta: "a b c 汉字" });
    const bytes = Buffer.from(`${record}\r\n`, "utf8");
    process.stdout.write(bytes.subarray(0, 40));
    await nextTurn();
    process.stdout.write(bytes.subarray(40, bytes.length - 9));
    await nextTurn();
    process.stdout.write(bytes.subarray(bytes.length - 9));
    await waitFor(() => events.length === 1);
    expect(events[0]).toEqual({ type: "bash_execution_update", delta: "a b c 汉字" });
  });
});

describe("PiRpcClient process end", () => {
  it("rejects pending requests when the process dies and reports the exit", async () => {
    const { options, held } = holding();
    const { spawner, start } = harness(options);
    const client = await start();
    const process = spawner.last();
    const pendingPrompt = caught(client.request({ type: "prompt", message: "x" }));
    const pendingStats = caught(client.request({ type: "get_session_stats" }));
    await waitFor(() => held.length === 2);
    process.stderr.write("fatal: something broke in /synthetic/accounts/someone/app/main.js\n");
    process.exit(1);
    const error = await pendingPrompt as PiRpcClosedError;
    expect(error).toBeInstanceOf(PiRpcClosedError);
    expect(error).toMatchObject({ name: "PiRpcClosedError", command: "prompt", message: "Pi exited before answering prompt" });
    expect(error.exit).toMatchObject({ code: 1, signal: null, expected: false });
    expect(error.exit!.stderrTail).toBe("fatal: something broke in …/main.js");
    expect(await pendingStats).toMatchObject({ name: "PiRpcClosedError", command: "get_session_stats" });
    expect(await client.exited).toEqual(error.exit);
    expect(client.isAlive).toBe(false);
    const after = await caught(client.request({ type: "get_state" })) as PiRpcClosedError;
    expect(after).toBeInstanceOf(PiRpcClosedError);
    expect(after.exit).toEqual(error.exit);
    expect(() => client.respondExtensionUi({ type: "extension_ui_response", id: "d", cancelled: true })).not.toThrow();
  });

  it("reports a signal death", async () => {
    const { spawner, start } = harness();
    const client = await start();
    spawner.last().kill("SIGKILL");
    expect(await client.exited).toMatchObject({ code: null, signal: "SIGKILL", expected: false });
  });

  it("processes a final record that has no newline before the exit", async () => {
    const { spawner, start } = harness();
    const client = await start();
    const process = spawner.last();
    const events: string[] = [];
    client.onEvent(event => { events.push(event.type); });
    process.send({ type: "agent_start" });
    process.sendRaw('{"type":"agent_settled","aborted":true}');
    process.exit(0);
    await client.exited;
    expect(events).toEqual(["agent_start", "agent_settled"]);
  });

  it("keeps only the tail of a long stderr", async () => {
    const { spawner, start } = harness();
    const client = await start();
    const process = spawner.last();
    process.stderr.write(`${"early noise ".repeat(2_000)}\n`);
    process.stderr.write("the last line matters\n");
    await nextTurn();
    process.exit(3);
    const exit = await client.exited;
    expect(exit.stderrTail.length).toBeLessThanOrEqual(1_200);
    expect(exit.code).toBe(3);
  });

  it("rejects a request when stdin is already broken, without waiting for a deadline", async () => {
    const { spawner, start } = harness();
    const client = await start();
    spawner.last().stdin.destroy();
    const error = await caught(client.request({ type: "prompt", message: "x" })) as PiRpcClosedError;
    expect(error).toBeInstanceOf(PiRpcClosedError);
    expect(error.command).toBe("prompt");
    expect(error.exit).toBeUndefined();
  });
});

describe("PiRpcClient.close and terminate", () => {
  it("ends stdin and reports an expected exit when Pi shuts down by itself", async () => {
    const { spawner, start, treeKills } = harness();
    const client = await start();
    const process = spawner.last();
    const exit = await client.close();
    expect(exit).toEqual({ code: 0, signal: null, expected: true, stderrTail: "" });
    expect(process.stdin.writableEnded).toBe(true);
    expect(process.killSignals).toEqual([]);
    expect(treeKills).toEqual([]);
    expect(client.isAlive).toBe(false);
  });

  it("is idempotent and refuses requests once closing", async () => {
    const { start } = harness();
    const client = await start();
    const first = client.close(), second = client.close({ graceMs: 1 });
    expect(second).toBe(first);
    const during = await caught(client.request({ type: "get_state" }));
    expect(during).toBeInstanceOf(PiRpcClosedError);
    expect(await first).toMatchObject({ code: 0, expected: true });
    expect(await client.close()).toEqual(await first);
    expect(await caught(client.request({ type: "get_state" }))).toBeInstanceOf(PiRpcClosedError);
  });

  it("returns the real exit when the process had already ended", async () => {
    const { spawner, start } = harness();
    const client = await start();
    spawner.last().exit(7);
    await client.exited;
    expect(await client.close()).toMatchObject({ code: 7, expected: false });
  });

  it("escalates in order: stdin EOF, then the process tree, then SIGKILL on its own handle", async () => {
    const { spawner, base } = harness();
    const order: string[] = [];
    const client = await PiRpcClient.start({ ...base, killProcessTreeFn: pid => { order.push(`tree:${pid}`); } }); // reaches nothing
    const process = spawner.last();
    process.stubborn = true; // ignores EOF and SIGTERM
    process.stdin.once("finish", () => { order.push("stdin-eof"); });
    const originalKill = process.kill.bind(process);
    process.kill = signal => { order.push(String(signal)); return originalKill(signal); };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let done = false;
    const closing = client.close({ graceMs: 100 }).then(exit => { done = true; return exit; });
    await vi.advanceTimersByTimeAsync(99);
    expect(order).toEqual(["stdin-eof"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(order).toEqual(["stdin-eof", "tree:4242"]);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(order).toEqual(["stdin-eof", "tree:4242"]);
    await vi.advanceTimersByTimeAsync(1);
    vi.useRealTimers();
    expect(await closing).toMatchObject({ code: null, signal: "SIGKILL", expected: true });
    expect(done).toBe(true);
    expect(order).toEqual(["stdin-eof", "tree:4242", "SIGKILL"]); // never a bare SIGTERM to the root
  });

  it("needs no signal to the root when the tree kill ends the process", async () => {
    const { spawner, start, treeKills } = harness(); // its tree killer ends every process
    const client = await start();
    const process = spawner.last();
    process.stubborn = true;
    const exit = await client.close({ graceMs: 20 });
    expect(treeKills).toEqual([4242]);
    expect(process.killSignals).toEqual(["SIGKILL"]); // the stand-in tree killer's own signal only
    expect(exit).toMatchObject({ signal: "SIGKILL", expected: true });
  });

  it("returns instead of hanging when nothing ends the process", async () => {
    const { spawner, base } = harness();
    let treeKillCalls = 0;
    const client = await PiRpcClient.start({ ...base, killProcessTreeFn: () => { treeKillCalls++; } });
    const process = spawner.last();
    process.stubborn = true;
    process.kill = signal => { process.killSignals.push(signal); return true; }; // not even SIGKILL lands
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const closing = client.close({ graceMs: 50 });
    await vi.advanceTimersByTimeAsync(50 + 2_000 + 5_000);
    vi.useRealTimers();
    expect(await closing).toEqual({ code: null, signal: null, expected: true, stderrTail: "" });
    expect(treeKillCalls).toBe(1);
    expect(process.killSignals).toEqual(["SIGKILL"]);
    expect(client.isAlive).toBe(true); // it says what it knows: the process never confirmed its end
  });

  // DEFECT (reported to the module owner): close() ends stdin synchronously, while writes wait
  // on a promise chain, so every record queued just before close() is dropped. Seen in
  // queryPiCatalog when a dialog arrives in the same chunk as the last answer: its cancellation
  // is never written. Drop `.fails` once close() lets the queued writes out first.
  it("writes the records queued before close() before it ends stdin", async () => {
    const { spawner, start } = harness();
    const client = await start();
    const process = spawner.last();
    client.respondExtensionUi({ type: "extension_ui_response", id: "a", cancelled: true });
    client.respondExtensionUi({ type: "extension_ui_response", id: "b", cancelled: true });
    await client.close();
    expect(process.uiResponses.map(response => response.id)).toEqual(["a", "b"]);
  });

  it("terminate() skips the orderly steps and marks the exit as expected", async () => {
    const { spawner, start, treeKills } = harness();
    const client = await start();
    const process = spawner.last();
    client.terminate();
    expect(process.stdin.destroyed).toBe(true);
    expect(process.stdin.writableEnded).toBe(false);
    expect(await client.exited).toMatchObject({ signal: "SIGKILL", expected: true });
    expect(treeKills).toEqual([4242]);
    expect(await caught(client.request({ type: "get_state" }))).toBeInstanceOf(PiRpcClosedError);
    client.terminate(); // harmless on a dead process
    expect(treeKills).toEqual([4242]);
  });

  // Windows: kill() is TerminateProcess of the root alone, Pi's SIGTERM handler never runs, and
  // `taskkill /T` cannot find the children of a root that has already gone. The official managed
  // launcher makes the root cmd.exe (pi.cmd -> pi-launcher.js -> Pi), so killing it first leaves Pi running.
  it("stops the process tree while its root is still alive, before any signal to the root", async () => {
    const { spawner, base } = harness();
    let process!: FakePiProcess;
    const seen: Array<{ pid: number | undefined; rootAlive: boolean; directKills: number }> = [];
    const client = await PiRpcClient.start({ ...base, killProcessTreeFn: pid => {
      seen.push({ pid, rootAlive: process.exitCode === null && process.signalCode === null, directKills: process.killSignals.length });
      process.kill("SIGKILL");
    } });
    process = spawner.last();
    process.stubborn = true; // a Pi whose shutdown hangs after stdin EOF
    const originalKill = process.kill.bind(process);
    process.kill = () => originalKill("SIGKILL"); // any direct kill ends the root at once, as on Windows
    const exit = await client.close({ graceMs: 20 });
    expect(seen).toEqual([{ pid: 4242, rootAlive: true, directKills: 0 }]);
    expect(exit).toMatchObject({ signal: "SIGKILL", expected: true });
  });

  it("falls back to SIGKILL on its own handle when the tree kill leaves the root running", async () => {
    // For example a container without pgrep/ps: the tree killer can only signal what it can enumerate.
    const { spawner, base } = harness();
    let treeKillCalls = 0;
    const client = await PiRpcClient.start({ ...base, killProcessTreeFn: () => { treeKillCalls++; } });
    const process = spawner.last();
    process.stubborn = true; // ignores EOF and SIGTERM, honours SIGKILL
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const closing = client.close({ graceMs: 50 });
    await vi.advanceTimersByTimeAsync(50 + 2_000 + 1);
    vi.useRealTimers();
    expect(await closing).toMatchObject({ code: null, signal: "SIGKILL", expected: true });
    expect(treeKillCalls).toBe(1);
    expect(process.killSignals).toEqual(["SIGKILL"]);
  });

  it("survives a tree killer that throws", async () => {
    const { spawner, base } = harness();
    const client = await PiRpcClient.start({ ...base, killProcessTreeFn: async () => { throw new Error("taskkill failed"); } });
    expect(() => client.terminate()).not.toThrow();
    await nextTurn();
    spawner.last().kill("SIGKILL");
    expect(await client.exited).toMatchObject({ expected: true });
  });
});

describe("queryPiCatalog", () => {
  const catalogInput = (h: ReturnType<typeof harness>, extra: Record<string, unknown> = {}) => ({ ...h.base, ...extra });

  it("returns the available models and the native default selection, then closes the process", async () => {
    const h = harness();
    const catalog = await queryPiCatalog(catalogInput(h, { extraArgs: ["--offline"] }));
    const process = h.spawner.last();
    expect(catalog.models).toHaveLength(3);
    expect(catalog.models[0]).toMatchObject({ provider: "fakeprov", id: "dup-model" });
    expect(catalog.current).toEqual({ provider: "fakeprov", modelId: "dup-model", thinkingLevel: "medium" });
    // `--no-session` and the extra arguments come after `--mode rpc`; nothing is persisted.
    expect(process.args).toEqual(["cli.js", "--mode", "rpc", "--no-session", "--offline"]);
    expect(process.received.map(command => command.type).sort()).toEqual(["get_available_models", "get_state", "get_state"]);
    await waitFor(() => process.exitCode === 0, "the catalog process to exit");
    expect(process.stdin.writableEnded).toBe(true);
    expect(h.treeKills).toEqual([]);
  });

  it("never switches the model or touches a session", async () => {
    const h = harness();
    await queryPiCatalog(catalogInput(h));
    const sent = h.spawner.last().received.map(command => command.type);
    for (const forbidden of ["set_model", "cycle_model", "set_thinking_level", "prompt", "new_session", "switch_session", "set_auto_retry"]) expect(sent).not.toContain(forbidden);
  });

  it("omits the current selection when Pi reports its placeholder model", async () => {
    const h = harness({ models: [] });
    const catalog = await queryPiCatalog(catalogInput(h));
    expect(h.spawner.last().state.model).toEqual(FAKE_PI_PLACEHOLDER_MODEL);
    expect(catalog).toEqual({ models: [] });
    expect("current" in catalog).toBe(false);
  });

  it("reports the model and thinking level Pi would start a new session with", async () => {
    const model = fakePiModel("openrouter", "vendor/model:free", { reasoning: false });
    const h = harness({ models: [fakePiModel("a", "x"), model], model, thinkingLevel: "off" });
    expect((await queryPiCatalog(catalogInput(h))).current).toEqual({ provider: "openrouter", modelId: "vendor/model:free", thinkingLevel: "off" });
  });

  it("tolerates a malformed model list", async () => {
    const h = harness({ onCommand: (command, process) => { if (command.type !== "get_available_models") return; process.respond(command, { models: "not a list" }); return true; } });
    expect((await queryPiCatalog(catalogInput(h))).models).toEqual([]);
  });

  it("cancels dialogs an extension opens before Pi answers the handshake", async () => {
    let first = true;
    const h = harness({
      onCommand: (command, process) => {
        if (!first) return;
        first = false;
        process.ui({ id: "early-select", method: "select", title: "Trust this project?", options: ["Yes", "No"] });
        process.ui({ id: "early-notify", method: "notify", message: "starting" });
        // Answer the handshake only once the cancellation has arrived.
        process.once("ui-response", () => process.respond(command, stateOf(process)));
        return true;
      },
    });
    const catalog = await queryPiCatalog(catalogInput(h));
    expect(catalog.models).toHaveLength(3);
    expect(h.spawner.last().uiResponses).toEqual([{ type: "extension_ui_response", id: "early-select", cancelled: true }]);
  });

  it("cancels every kind of dialog during the read and answers no fire-and-forget record", async () => {
    const h = harness({
      onCommand: (command, process) => {
        if (command.type !== "get_available_models") return;
        process.ui({ id: "d-confirm", method: "confirm", title: "Sure?", message: "m" });
        process.ui({ id: "d-input", method: "input", title: "Name" });
        process.ui({ id: "d-editor", method: "editor", title: "Edit" });
        process.ui({ id: "d-status", method: "setStatus", statusKey: "k", statusText: "t" });
        process.ui({ id: "d-widget", method: "setWidget", widgetKey: "k", widgetLines: ["a"] });
        process.ui({ id: "d-title", method: "setTitle", title: "t" });
        process.ui({ id: "d-editor-text", method: "set_editor_text", text: "t" });
        // The extension is blocked on its dialogs, so Pi answers the read only after they were cancelled.
        const answerWhenCancelled = () => { if (process.uiResponses.length === 3) { process.off("ui-response", answerWhenCancelled); process.respond(command, { models: process.models }); } };
        process.on("ui-response", answerWhenCancelled);
        return true;
      },
    });
    const catalog = await queryPiCatalog(catalogInput(h));
    expect(catalog.models).toHaveLength(3);
    const process = h.spawner.last();
    expect(process.uiResponses).toEqual([
      { type: "extension_ui_response", id: "d-confirm", cancelled: true },
      { type: "extension_ui_response", id: "d-input", cancelled: true },
      { type: "extension_ui_response", id: "d-editor", cancelled: true },
    ]);
  });

  it("bounds a silent process by the total deadline and stops it", async () => {
    const h = harness({ silent: true });
    const started = Date.now();
    const error = await caught(queryPiCatalog(catalogInput(h, { timeoutMs: 60 })));
    expect(error).toMatchObject({ name: "PiStartupError", reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(h.treeKills).toEqual([4242]);
  });

  it("spends one budget on startup and the reads together, not one per command", async () => {
    let first = true;
    const h = harness({
      onCommand: (command, process) => {
        if (first) { first = false; setTimeout(() => process.respond(command, stateOf(process)), 120); return true; }
        return true; // the reads are never answered
      },
    });
    // Stream plumbing keeps running on real ticks; only the clock and the timers are under test control.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const pump = async () => { for (let turn = 0; turn < 5; turn++) await nextTurn(); };
    let outcome: unknown;
    void queryPiCatalog(catalogInput(h, { timeoutMs: 300 })).then(value => { outcome = value; }, error => { outcome = error; });
    await pump();
    expect(h.spawner.last().received.map(command => command.type)).toEqual(["get_state"]);
    await vi.advanceTimersByTimeAsync(120); // Pi needed 120 ms of the budget to start
    await pump();
    expect(h.spawner.last().received.map(command => command.type).sort()).toEqual(["get_available_models", "get_state", "get_state"]);
    await vi.advanceTimersByTimeAsync(179);
    await pump();
    expect(outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await pump();
    expect(outcome).toBeInstanceOf(PiRpcTimeoutError);
    // What was left of the 300 ms, not a fresh 300 ms for each read.
    expect((outcome as PiRpcTimeoutError).timeoutMs).toBe(180);
    vi.useRealTimers();
    const process = h.spawner.last();
    await waitFor(() => process.exitCode !== null || process.signalCode !== null, "the catalog process to end");
  });

  it("does not start a process for a signal that is already aborted", async () => {
    const h = harness();
    const controller = new AbortController();
    controller.abort(new Error("cancelled before start"));
    expect(await caught(queryPiCatalog(catalogInput(h, { signal: controller.signal })))).toMatchObject({ message: "cancelled before start" });
    expect(h.spawner.processes).toHaveLength(0);
  });

  it("stops and closes the process when the signal aborts mid-read", async () => {
    const controller = new AbortController(), reason = new Error("settings page closed");
    const h = harness({
      onCommand: command => {
        if (command.type !== "get_available_models") return;
        queueMicrotask(() => controller.abort(reason));
        return true;
      },
    });
    expect(await caught(queryPiCatalog(catalogInput(h, { signal: controller.signal })))).toBe(reason);
    const process = h.spawner.last();
    await waitFor(() => process.exitCode !== null || process.signalCode !== null, "the catalog process to end");
  });

  it("propagates a startup failure unchanged", async () => {
    const h = harness({ exitAtStart: { code: 1, stderr: "Error: --mode requires text, json, or rpc\n" } });
    const error = await caught(queryPiCatalog(catalogInput(h)));
    expect(error).toMatchObject({ name: "PiStartupError", reason: "exit", message: "Pi exited during startup (code 1): Error: --mode requires text, json, or rpc" });
  });

  it("uses the default spawn only when none is injected", async () => {
    // Guard for the tests themselves: every case above went through the fake.
    const h = harness();
    await queryPiCatalog(catalogInput(h));
    expect(h.spawner.processes).toHaveLength(1);
    expect((h.spawner.last() as unknown as ChildProcess).pid).toBe(4242);
  });
});
