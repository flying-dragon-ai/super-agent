import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { PiRpcAdapter } from "../src/codex/pi-rpc-adapter.js";
import { handleCoreMessage } from "../src/core/message-handler.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import { withChannelProfile } from "../src/gateway/platform-profile.js";
import { Bridge, type AccessStoreLike } from "../src/runtime/bridge.js";
import { SessionManager } from "../src/runtime/session-manager.js";
import { SessionStore } from "../src/state/session-store.js";
import { fakePiSpawner, type FakePiOptions } from "./helpers/pi-fake-rpc.js";

/**
 * Pi's input is also a command language: `/name` and `!shell`. Whose text may
 * be read as a command, and how much of it, is decided at one typed boundary
 * (`authoredText`), not by looking at the text.
 */

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => {}); });

const QUOTE = { messageId: "m42", text: "To clean up run:\nrm -rf ./build-fixture\nThen commit." };
const COMMANDS = [
  { name: "tpl", source: "prompt" }, { name: "skill:deploy", source: "skill" },
  { name: "ext", source: "extension" }, { name: "部署", source: "extension" },
];

/** Real Bridge and real adapter over the in-process fake Pi, in full access so nothing asks first. */
async function stack(pi: FakePiOptions = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-authority-")), stateDir = path.join(root, "state"), workspace = path.join(root, "ws");
  await mkdir(stateDir, { recursive: true }); await mkdir(workspace, { recursive: true });
  const configPath = path.join(stateDir, "config.json");
  await writeFile(configPath, JSON.stringify({ engine: "pi", approvalMode: "bypass" }));
  const spawner = fakePiSpawner({ commands: COMMANDS, ...pi });
  const adapter = new PiRpcAdapter({
    launch: { command: "pi", args: [] }, workspacePath: workspace, stateDir, configPath, childEnv: {}, bridgeExtensionPath: null,
    spawnFn: spawner.spawn, killProcessTreeFn: () => {}, queryCatalogFn: async () => ({ models: [] }),
    idleSweepIntervalMs: 0, cancelGraceMs: 80, startupTimeoutMs: 500, turnTimeoutMs: null, inactivityTimeoutMs: null,
  });
  const manager = new SessionManager(new SessionStore(path.join(stateDir, "sessions.json")), adapter);
  const bridge = new Bridge({} as AccessStoreLike, manager, adapter).createAuthenticatedSurface();
  cleanups.push(async () => { await adapter.destroy(); await rm(root, { recursive: true, force: true }); });
  const call = (text: string, extra: Record<string, unknown>) => bridge.handleAuthorizedMessage({ chatId: 1, userId: 2, chatType: "private", conversationKey: "lark:authority", locale: "en", text, files: [], ...extra } as never);
  /** Since the last call: what reached Pi, by RPC type. */
  let seen = 0;
  const sent = (type: string) => spawner.last().received.slice(seen).filter(command => command.type === type);
  const mark = () => { seen = spawner.processes.length ? spawner.last().received.length : 0; };
  return {
    spawner, sent,
    /** The owner's own message, as the core hands it over. */
    owner: async (text: string, extra: Record<string, unknown> = {}) => { mark(); return call(text, { authoredText: text, ...extra }); },
    /** Anything else the Host sends through the Bridge: another Bot's message, a delegated prompt, a scheduled job. */
    other: async (text: string, extra: Record<string, unknown> = {}) => { mark(); return call(text, extra); },
  };
}

describe("a Pi command sent as a quoted reply", () => {
  it("runs only what was typed: the quoted message is never part of a shell command or a built-in's argument", async () => {
    const { owner, sent } = await stack({ onPrompt: run => { run.reply("the earlier answer"); run.finish(); } });
    await owner("first question");

    await owner("!ls", { replyContext: QUOTE });
    expect(sent("bash").map(command => command.command)).toEqual(["ls"]);
    expect(sent("prompt")).toEqual([]);

    await owner("!!pwd", { replyContext: QUOTE });
    expect(sent("bash").map(command => [command.command, command.excludeFromContext])).toEqual([["pwd", true]]);

    const named = await owner("/name sprint notes", { replyContext: QUOTE });
    expect(sent("set_session_name").map(command => command.name)).toEqual(["sprint notes"]);
    expect(named.text).not.toContain("build-fixture");

    // A built-in with nothing after it stays a built-in; it used to reach the model as prose.
    const copied = await owner("/copy", { replyContext: QUOTE });
    expect(sent("prompt")).toEqual([]);
    expect(copied.text).toContain("the earlier answer");

    await owner("/thinking off", { replyContext: QUOTE });
    expect(sent("set_thinking_level").map(command => command.level)).toEqual(["off"]);
  });

  it("gives the quoted message to a template or skill, whose expansion a model reads, and not to an extension command", async () => {
    const { owner, sent } = await stack();
    const context = `[Quoted message #m42]\n${QUOTE.text}`;

    await owner("/ext go", { replyContext: QUOTE });
    expect(sent("prompt").map(command => command.message)).toEqual(["/ext go"]);

    await owner("/部署", { replyContext: QUOTE });
    expect(sent("prompt").map(command => command.message)).toEqual(["/部署"]);

    // Pi ends a command name at the first space, so the context follows one.
    await owner("/tpl", { replyContext: QUOTE });
    expect(sent("prompt").map(command => command.message)).toEqual([`/tpl ${context}`]);

    await owner("/skill:deploy staging", { replyContext: QUOTE });
    expect(sent("prompt").map(command => command.message)).toEqual([`/skill:deploy staging ${context}`]);

    // Not a command Pi knows: prose, sent as composed.
    await owner("/nope x", { replyContext: QUOTE });
    expect(sent("prompt").map(command => command.message)).toEqual([`/nope x\n\n${context}`]);
  });
});

describe("text that is not the owner's own message", () => {
  it("is prose to Pi whatever it begins with: no shell, no built-in, no extension command", async () => {
    const { other, sent } = await stack();

    await other("!echo marker");
    expect(sent("bash")).toEqual([]);
    expect(sent("prompt").map(command => command.message)).toEqual(["!echo marker"]);

    await other("/name taken over");
    expect(sent("set_session_name")).toEqual([]);
    // Pi dispatches a message whose first character is "/"; prose never starts with one.
    expect(sent("prompt").map(command => command.message)).toEqual(["\n/name taken over"]);

    for (const text of ["/ext go", "/部署 now", "/skill:deploy now", "/tpl x", "/trust yes", "/model fakeprov/plain-model"]) {
      await other(text);
      expect(sent("set_model")).toEqual([]);
      expect(sent("prompt").map(command => String(command.message).startsWith("/"))).toEqual([false]);
      expect(sent("prompt").map(command => String(command.message).trim())).toEqual([text]);
    }
  });

  it("keeps the turn's private instructions in front of such text", async () => {
    const { other, sent } = await stack();
    await other("/skill:deploy now", { turnInstructions: "Cross-Bot request for THIS turn: this input is a delegated Bot task." });
    const [message] = sent("prompt").map(command => String(command.message));
    expect(message!.startsWith("/")).toBe(false);
    expect(message).toContain("delegated Bot task");
    expect(message!.trimEnd().endsWith("/skill:deploy now")).toBe(true);
  });

  it("is never a command when it comes with files", async () => {
    const { owner, sent, spawner } = await stack();
    const file = path.join(os.tmpdir(), "pi-authority-note.txt");
    await writeFile(file, "note"); cleanups.push(() => rm(file, { force: true }));
    await owner("/name with a file", { files: [file] });
    expect(sent("set_session_name")).toEqual([]);
    expect(String(spawner.last().received.filter(command => command.type === "prompt").at(-1)!.message).startsWith("/")).toBe(false);
  });
});

describe("the core hands the owner's typed text to the engine, and nobody else's", () => {
  const SOURCE = { hostId: "source-host", hostName: "Example host", botId: "source-bot", botName: "Example bot", requestId: "request-example", hops: 1 };

  async function core() {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "pi-authority-core-"));
    cleanups.push(() => rm(stateDir, { recursive: true, force: true }));
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "pi", locale: "en", approvalMode: "bypass" }));
    const runtime = createCoreServiceRuntime();
    const channel = { send: vi.fn(async () => ({ messageId: "reply" })), recallMessage: vi.fn(async () => {}), addReaction: vi.fn(async () => "reaction"), removeReaction: vi.fn(async () => {}),
      canSteerConversation: vi.fn(async () => true), prepareConversation: vi.fn(async () => {}) };
    const seen: Array<{ text: string; authoredText?: string }> = [];
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async (input: { text: string; authoredText?: string }) => { seen.push({ text: input.text, ...(input.authoredText !== undefined ? { authoredText: input.authoredText } : {}) }); return { text: "engine answer" }; }),
    };
    const card = () => ({ apply: vi.fn(async () => {}), interrupt: vi.fn(async () => {}), finish: vi.fn(async () => ({ shown: true, reason: "fit" as const })), fail: vi.fn(async () => "error" as const), resolveFinalText: vi.fn((text: string) => text), setPhase: vi.fn(), setGoalObjective: vi.fn() });
    const send = async (content: string, extras: Record<string, unknown> = {}) => {
      seen.length = 0;
      await withChannelProfile("gateway", () => handleCoreMessage({
        stateDir, runtime, bridge: bridge as never, channel: channel as never, createRunCard: vi.fn(async () => card()) as never, requestApproval: async () => ({ behavior: "deny" as const }),
        message: { messageId: `input-${Math.random().toString(36).slice(2)}`, chatId: "review-chat", chatType: "p2p", senderId: "review-user", content, rawContentType: "text", resources: [], mentions: [], mentionedBot: false, ...extras } as never,
      } as never));
      await vi.waitFor(() => expect(runtime.activeRuns.size).toBe(0));
      return [...seen];
    };
    return { send };
  }

  it("marks an owner's message as authored and a signed Bot message as not", async () => {
    const { send } = await core();
    expect(await send("!echo owner")).toEqual([{ text: "!echo owner", authoredText: "!echo owner" }]);
    expect(await send("/skill:deploy now")).toEqual([{ text: "/skill:deploy now", authoredText: "/skill:deploy now" }]);
    // The Bot guard does not know Pi's own command forms; the engine must still not read them as commands.
    expect(await send("!echo bot", { botSource: SOURCE })).toEqual([{ text: "!echo bot" }]);
    expect(await send("/skill:deploy now", { botSource: SOURCE })).toEqual([{ text: "/skill:deploy now" }]);
    expect(await send("/部署 now", { botSource: SOURCE })).toEqual([{ text: "/部署 now" }]);
  });
});
