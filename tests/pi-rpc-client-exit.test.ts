import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PiRpcClient, PiRpcClosedError } from "../src/codex/pi-rpc-client.js";

/**
 * Real processes: the pipe semantics under test (a child's `close` waits for
 * every process that holds its stdout or stderr) do not exist in the in-process
 * fake. The peer speaks just enough RPC to start a client; it is not Pi.
 *
 * PEER_MODE, acted on when the client sends `bash`:
 *   quiet   leave a detached process holding stderr, silent, and die
 *   chatty  the same, but that process keeps writing to stderr
 *   tail    answer in two writes that split a UTF-8 character, no final newline, then exit normally
 */
const PEER = `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const mode = process.env.PEER_MODE;
let buffer = "";
process.stdin.on("data", chunk => {
  buffer += chunk;
  for (let end = buffer.indexOf("\\n"); end >= 0; end = buffer.indexOf("\\n")) {
    const command = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
    if (command.type === "get_state") process.stdout.write(JSON.stringify({ type: "response", id: command.id, command: "get_state", success: true, data: { sessionId: "s", thinkingLevel: "off", isStreaming: false, isCompacting: false, steeringMode: "all", followUpMode: "all", autoCompactionEnabled: true, messageCount: 0, pendingMessageCount: 0 } }) + "\\n");
    if (command.type !== "bash") continue;
    if (mode === "tail") {
      const record = Buffer.from(JSON.stringify({ type: "response", id: command.id, command: "bash", success: true, data: { output: "尾声 🎉 done", exitCode: 0, cancelled: false, truncated: false } }), "utf8");
      const cut = record.indexOf(Buffer.from("🎉", "utf8")) + 2; // inside the four bytes of the emoji
      process.stdout.write(record.subarray(0, cut));
      setTimeout(() => process.stdout.write(record.subarray(cut), () => process.exit(0)), 30);
      continue;
    }
    // What an extension's own helper process does when it is started with inherited stdio and outlives Pi.
    const script = mode === "chatty" ? "setInterval(() => process.stderr.write('still here\\\\n'), 40); setTimeout(() => {}, 30000)" : "setTimeout(() => {}, 30000)";
    const kept = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "ignore", "inherit"], detached: true });
    kept.unref();
    writeFileSync(process.env.KEPT_PID_FILE, String(kept.pid));
    process.stdout.write(JSON.stringify({ type: "bash_execution_update", delta: "last words" }) + "\\n");
    setTimeout(() => process.exit(7), 20);
  }
});
`;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => {}); });

async function peer(mode: "quiet" | "chatty" | "tail") {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-exit-"));
  const script = path.join(root, "peer.mjs"), pidFile = path.join(root, "kept.pid");
  await writeFile(script, PEER);
  cleanups.push(async () => {
    try { process.kill(Number(await readFile(pidFile, "utf8"))); } catch { /* it never started or is already gone */ }
    await rm(root, { recursive: true, force: true });
  });
  const client = await PiRpcClient.start({
    launch: { command: process.execPath, args: [script] }, cwd: root, env: { ...process.env, PEER_MODE: mode, KEPT_PID_FILE: pidFile },
    spawnFn: (command, args, options) => spawn(command, args, options), killProcessTreeFn: () => {},
  });
  cleanups.push(async () => { client.terminate(); });
  const events: string[] = [];
  client.onEvent(event => { if (event.type === "bash_execution_update") events.push(event.delta); });
  const keptAlive = () => { try { process.kill(Number(readFileSync(pidFile, "utf8")), 0); return true; } catch { return false; } };
  return { client, events, keptAlive };
}

/** `work`, or "still open" after `ms`. The timer is cleared as soon as either side has won. */
async function within<T>(work: Promise<T>, ms: number): Promise<T | "still open"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<"still open">(resolve => { timer = setTimeout(() => resolve("still open"), ms); })]); }
  finally { clearTimeout(timer); }
}

describe("PiRpcClient and a process that outlives Pi holding its output pipe", () => {
  it("ends once Pi has exited and the pipes are quiet, without waiting for that process", async () => {
    const { client, events, keptAlive } = await peer("quiet");
    const pending = client.request({ type: "bash", command: "anything" }).then(() => "answered", error => error);

    const exit = await within(client.exited, 6_000);
    expect(exit).not.toBe("still open");
    expect(exit).toMatchObject({ code: 7, expected: false });
    // What Pi wrote before it died was still read.
    expect(events).toEqual(["last words"]);
    expect(client.isAlive).toBe(false);
    expect(await pending).toBeInstanceOf(PiRpcClosedError);
    await expect(client.request({ type: "get_state" })).rejects.toBeInstanceOf(PiRpcClosedError);
    // The other process was left alone: only our end of the pipe was closed.
    expect(keptAlive()).toBe(true);
  }, 15_000);

  it("ends within a fixed time even while that process keeps writing", async () => {
    const { client, events, keptAlive } = await peer("chatty");
    const started = Date.now();
    const pending = client.request({ type: "bash", command: "anything" }).then(() => "answered", error => error);

    const exit = await within(client.exited, 8_000);
    expect(exit).not.toBe("still open");
    expect(exit).toMatchObject({ code: 7, expected: false });
    // Its output kept the quiet period from ever starting, so it was the limit that ended the wait.
    expect(Date.now() - started).toBeGreaterThan(2_000);
    expect(events).toEqual(["last words"]);
    expect(await pending).toBeInstanceOf(PiRpcClosedError);
    expect(keptAlive()).toBe(true);
  }, 15_000);
});

describe("PiRpcClient at an ordinary exit", () => {
  it("still delivers a last answer that arrives in pieces, split inside a character and without a final newline", async () => {
    const { client } = await peer("tail");
    const answer = await within(client.request({ type: "bash", command: "anything" }), 6_000);
    expect(answer).toMatchObject({ output: "尾声 🎉 done", exitCode: 0 });
    expect(await within(client.exited, 6_000)).toMatchObject({ code: 0, signal: null, expected: false });
    expect(client.isAlive).toBe(false);
  }, 15_000);
});
