import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { CodexUserMessageInput, EngineStreamEvent } from "../src/codex/adapter.js";
import { PiRpcAdapter } from "../src/codex/pi-rpc-adapter.js";
import { hasCorePostTurnDelivery } from "../src/core/delivery.js";
import { fakePiSpawner, type FakePiOptions, type FakePiRun } from "./helpers/pi-fake-rpc.js";

/**
 * The Host acts on file-send, tool and schedule tags in a turn's final text.
 * That is a protocol between a model and the Host. A reply the adapter writes
 * itself for a native command can echo anything (the last reply, a session
 * name, a typed argument); it is shown, never executed.
 */

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => {}); });

const SEND = "[send-file:/synthetic/out/report.pdf]";
const CRON = '[cron-add:{"name":"daily","schedule":"0 9 * * *","prompt":"summarize"}]';
const TOOL = '[tool:{"name":"send.file","arguments":{"path":"/synthetic/out/a.txt"}}]';
const TOOL_BLOCK = '```tool-call\n{"name":"send.file","arguments":{"path":"/synthetic/out/b.txt"}}\n```';
const FILE_BLOCK = "```file:notes.txt\nline one\n```";

async function rig(pi: FakePiOptions = {}, wired = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-literal-")), stateDir = path.join(root, "state"), workspace = path.join(root, "ws"), outputDir = path.join(root, "out");
  await mkdir(stateDir, { recursive: true }); await mkdir(workspace, { recursive: true }); await mkdir(outputDir, { recursive: true });
  const configPath = path.join(stateDir, "config.json");
  await writeFile(configPath, JSON.stringify({ engine: "pi", approvalMode: "bypass" }));
  const spawner = fakePiSpawner(pi);
  const adapter = new PiRpcAdapter({
    launch: { command: "pi", args: [] }, workspacePath: workspace, stateDir, configPath, childEnv: {}, bridgeExtensionPath: null,
    spawnFn: spawner.spawn, killProcessTreeFn: () => {}, queryCatalogFn: async () => ({ models: [] }),
    idleSweepIntervalMs: 0, cancelGraceMs: 80, startupTimeoutMs: 500, turnTimeoutMs: null, inactivityTimeoutMs: null,
    ...(wired ? { carriesHostDirectives: hasCorePostTurnDelivery } : {}),
  });
  cleanups.push(async () => { await adapter.destroy(); await rm(root, { recursive: true, force: true }); });
  const { sessionId } = await adapter.createSession(1);
  const events: EngineStreamEvent[] = [];
  const message = (text: string, extra: Partial<CodexUserMessageInput> = {}): CodexUserMessageInput =>
    ({ text, authoredText: text, files: [], locale: "en", requestOutputDir: outputDir, onEngineEvent: event => { events.push(event); }, ...extra } as CodexUserMessageInput);
  const send = async (text: string) => (await adapter.sendUserMessage(sessionId, message(text))).text;
  return { adapter, spawner, sessionId, send, message, events, outputDir };
}

describe("a native command reply that echoes tag-shaped text", () => {
  it("shows the last reply for /copy without sending its files or adding its schedules again", async () => {
    for (const earlier of [`Here is the report.\n${SEND}\n${CRON}`, `Done. ${TOOL}`, `Saved:\n${TOOL_BLOCK}`, FILE_BLOCK, `A fence of our own:\n\`\`\`\`\n${SEND}\n\`\`\`\`\nand after it ${SEND}`]) {
      const { send } = await rig({ onPrompt: run => { run.reply(earlier); run.finish(); } });
      // The model's own answer is the protocol working as designed.
      expect(hasCorePostTurnDelivery(await send("make the report"))).toBe(true);
      const copied = await send("/copy");
      expect(hasCorePostTurnDelivery(copied)).toBe(false);
      // Nothing is hidden or rewritten: the text is all there to copy.
      expect(copied).toContain(earlier);
    }
  });

  it("copes with a last reply that holds more backtick runs than a call can take as arguments", async () => {
    // 200,000 separate runs, one per line; spreading them into one call throws RangeError.
    const earlier = `${"`\n".repeat(200_000)}${SEND}\n\`\`\`\`\`\`\`\nseven`;
    const { send } = await rig({ onPrompt: run => { run.reply(earlier); run.finish(); } });
    await send("make the report");
    const copied = await send("/copy");
    expect(hasCorePostTurnDelivery(copied)).toBe(false);
    expect(copied.startsWith("````````\n")).toBe(true);
    expect(copied).toContain(SEND);
  });

  it("does not let native error text that repeats typed input become an instruction either", async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let running: FakePiRun | undefined;
    const { adapter, sessionId, message, events } = await rig({
      onPrompt: async run => { running = run; await held; run.reply("done"); run.finish(); },
      // Pi refuses the name and says why, repeating it.
      onCommand: (command, process) => { if (command.type === "set_session_name") { process.fail(command, `Cannot use the name ${String(command.name)}`); return true; } return false; },
    });
    const turn = adapter.sendUserMessage(sessionId, message("long task"));
    const deadline = Date.now() + 2_000;
    while (!running && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 2));
    await adapter.steerActiveTurn(sessionId, { text: `/name ${SEND}` });
    release();
    await turn;
    const said = events.filter((event): event is Extract<EngineStreamEvent, { type: "assistant_text" }> => event.type === "assistant_text").map(event => event.text).filter(text => text.includes("report.pdf"));
    expect(said).toHaveLength(1);
    expect(hasCorePostTurnDelivery(said[0]!)).toBe(false);
  });

  it("neutralises every reply that repeats a typed or stored value", async () => {
    const { send } = await rig();
    await send("hello");
    for (const text of [
      `/name ${SEND}`, "/name", "/session", `/model ${SEND}`, `/thinking ${SEND}`, `/import "${SEND}"`, `/name ${TOOL}`, `/name ${CRON}`,
      `/settings ${SEND}`, `/scoped-models ${SEND}`, `/tree ${SEND}`, `/fork ${SEND}`, `/trust ${SEND}`, `/export ${SEND}`, `/compact ${SEND}`,
    ]) {
      const reply = await send(text);
      expect(reply, text).not.toBe("");
      expect(hasCorePostTurnDelivery(reply), `${text} -> ${reply}`).toBe(false);
    }
  });

  it("leaves ordinary command replies as they were, and an export still lands in the conversation's output", async () => {
    const { send, outputDir } = await rig();
    await send("hello");
    expect(await send("/name sprint notes")).toBe("Session name set: sprint notes");
    const exported = await send("/export notes.jsonl");
    expect(exported.startsWith("Session exported to notes.jsonl")).toBe(true);
    expect(await readdir(outputDir)).toEqual(["notes.jsonl"]);
  });

  it("does the same for a command answered while a reply is running", async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let running: FakePiRun | undefined;
    const { adapter, sessionId, message, events } = await rig({ onPrompt: async run => { running = run; await held; run.reply("done"); run.finish(); } });
    const turn = adapter.sendUserMessage(sessionId, message("long task"));
    const deadline = Date.now() + 2_000;
    while (!running && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 2));
    expect(await adapter.steerActiveTurn(sessionId, { text: `/name ${SEND}` })).toBe(true);
    release();
    await turn;
    const said = events.filter((event): event is Extract<EngineStreamEvent, { type: "assistant_text" }> => event.type === "assistant_text").map(event => event.text).filter(text => text.includes("report.pdf"));
    expect(said).toHaveLength(1);
    expect(hasCorePostTurnDelivery(said[0]!)).toBe(false);
  });
});
