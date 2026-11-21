import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { gatewayPiSession } from "../src/gateway/pi-session.js";
import type { GatewayChannel } from "../src/gateway/channel.js";
import { Bridge, type AccessStoreLike } from "../src/runtime/bridge.js";
import { PiNativeRejectedError, PiNativeUncertainError, type PiNativeState } from "../src/codex/pi-native-types.js";
import { piSessionChangeSchema, piSessionSnapshotSchema } from "../src/client-protocol/pi-session.js";
import { PiRpcAdapter } from "../src/codex/pi-rpc-adapter.js";
import { fakePiSpawner } from "./helpers/pi-fake-rpc.js";

const input = { botId: "pi_bot", conversationId: "chat", userId: "owner", requestId: "request", expectedSession: "opaque", action: "model" as const, value: "provider/model" };
const state: PiNativeState = {
  sessionId: "native", model: { provider: "provider", modelId: "model", name: "Model", reasoning: true, input: ["text"], contextWindow: 1000 },
  modelSource: "session", thinkingLevel: "high", availableThinkingLevels: ["off", "high"], isStreaming: true, isCompacting: false,
  steeringMode: "all", followUpMode: "all", autoCompactionEnabled: true, pending: { steering: [], followUp: [] }, bridge: "connected",
  ui: { status: { progress: "Running" }, widgets: { steps: { lines: ["Step 1"], placement: "aboveEditor" } }, title: "Session" },
};
const scope = { chatId: 1, conversationKey: "lark:chat" };
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function gatewayFixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-controls-")); dirs.push(dir);
  const bridge = { handleAuthorizedMessage: vi.fn(), getPiSession: vi.fn(async () => ({ supported: true })), changePiSession: vi.fn(async () => ({ outcome: "accepted" as const })) };
  const channel = { transport: { capabilities: ["pi.session.v1"], requestLive: vi.fn(async () => ({ allowed: true })) }, canSteerConversation: vi.fn(async () => true) };
  const create = () => gatewayPiSession(bridge, channel as unknown as GatewayChannel, dir, "pi_bot");
  return { bridge, channel, run: create(), create };
}
function bridgeFixture() {
  let binding = "native", current = true;
  const live = {
    token: "opaque_worker_generation", isCurrent: vi.fn(() => current), getState: vi.fn(async () => state),
    listCommands: vi.fn(async () => [{ name: "lab:2", source: "extension", description: "Native command", filePath: "PRIVATE_SOURCE", scope: "project" }]),
    listModels: vi.fn(async () => [{ provider: "provider", id: "model", name: "Model", reasoning: true, apiKey: "MUST_NOT_LEAVE_HOST", baseUrl: "https://private.invalid" }]),
    setModel: vi.fn(async (_model: unknown, options: { isCurrent: () => Promise<boolean> }) => { if (!await options.isCurrent()) throw new PiNativeRejectedError("stale", "not-found"); return state; }),
    setThinkingLevel: vi.fn(async (_level: unknown, options: { isCurrent: () => Promise<boolean> }) => { if (!await options.isCurrent()) throw new PiNativeRejectedError("stale", "not-found"); return state; }),
  };
  const controls = { getState: vi.fn(), getLiveSession: vi.fn(() => current ? live : undefined) };
  const adapter = { createSession: vi.fn(), sendUserMessage: vi.fn(), piNative: controls };
  const sessions = { getOrCreateSession: vi.fn(), bindSession: vi.fn(), getExistingSession: vi.fn(async () => binding ? { sessionId: binding } : null) };
  const bridge = new Bridge({ load: vi.fn(), issuePairingCode: vi.fn() } as AccessStoreLike, sessions, adapter);
  return { bridge, live, controls, adapter, sessions, bind: (value: string) => { binding = value; }, retire: () => { current = false; } };
}

describe("Pi live session snapshots and mutation boundaries", () => {
  it("exposes only current native command metadata without source paths or starting a worker", async () => {
    const f = bridgeFixture();
    const snapshot = await f.bridge.getPiSession(scope);
    expect(snapshot.session?.commands).toEqual([{ name: "lab:2", source: "extension", description: "Native command" }]);
    expect(JSON.stringify(snapshot)).not.toContain("PRIVATE_SOURCE");
    expect(f.sessions.getOrCreateSession).not.toHaveBeenCalled();
    f.live.listCommands.mockImplementation(async () => { f.bind("next"); return []; });
    expect(await f.bridge.getPiSession(scope)).toEqual({ supported: true });
  });
  it("clearing only thinking keeps an explicit conversation model", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pi-controls-thinking-")); dirs.push(dir);
    const configPath = path.join(dir, "config.json");
    await writeFile(configPath, JSON.stringify({ engine: "pi", approvalMode: "bypass", model: "fakeprov/dup-model", effort: "high" }));
    const spawner = fakePiSpawner();
    const adapter = new PiRpcAdapter({ launch: { command: "synthetic-pi", args: [] }, workspacePath: dir, stateDir: dir, configPath, childEnv: {}, bridgeExtensionPath: null, spawnFn: spawner.spawn, idleSweepIntervalMs: 0 });
    try {
      const { sessionId } = await adapter.createSession(1);
      await adapter.sendUserMessage(sessionId, { text: "hello", files: [] });
      await adapter.piNative.setModel(sessionId, { provider: "fakeprov2", modelId: "dup-model" });
      await adapter.piNative.setThinkingLevel(sessionId, "low");
      const sessions = { getOrCreateSession: vi.fn(), bindSession: vi.fn(), getExistingSession: vi.fn(async () => ({ sessionId })) };
      const bridge = new Bridge({ load: vi.fn(), issuePairingCode: vi.fn() } as AccessStoreLike, sessions, adapter);
      const snapshot = await bridge.getPiSession(scope);
      expect(snapshot.session).toMatchObject({ model: "fakeprov2/dup-model", thinking: "low" });
      expect(await bridge.changePiSession({ ...scope, expectedSession: snapshot.session!.token, action: "thinking", value: null })).toEqual({ outcome: "accepted" });
      expect((await bridge.getPiSession(scope)).session).toMatchObject({ model: "fakeprov2/dup-model", thinking: "high", modelSource: "session" });
    } finally { await adapter.destroy(); }
  });
  it("integrates Bridge with the production adapter's live-only handle without starting from GET", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pi-controls-native-")); dirs.push(dir);
    const spawner = fakePiSpawner();
    const adapter = new PiRpcAdapter({ launch: { command: "synthetic-pi", args: [] }, workspacePath: dir, stateDir: dir, childEnv: {}, bridgeExtensionPath: null, spawnFn: spawner.spawn, idleSweepIntervalMs: 0 });
    try {
      const { sessionId } = await adapter.createSession(1);
      const sessions = { getOrCreateSession: vi.fn(), bindSession: vi.fn(), getExistingSession: vi.fn(async () => ({ sessionId })) };
      const bridge = new Bridge({ load: vi.fn(), issuePairingCode: vi.fn() } as AccessStoreLike, sessions, adapter);
      expect(await bridge.getPiSession(scope)).toEqual({ supported: true }); expect(spawner.processes).toHaveLength(0);
      // Simulate a worker that a previous normal message already started.
      await adapter.piNative.getState(sessionId);
      const snapshot = await bridge.getPiSession(scope);
      expect(snapshot.session?.model).toBe("fakeprov/dup-model");
      expect(await bridge.changePiSession({ ...scope, expectedSession: snapshot.session!.token, action: "model", value: "fakeprov2/dup-model" })).toEqual({ outcome: "accepted" });
      expect((await bridge.getPiSession(scope)).session?.model).toBe("fakeprov2/dup-model");
      await adapter.destroy();
      expect(await bridge.getPiSession(scope)).toEqual({ supported: true }); expect(spawner.processes).toHaveLength(1);
      expect(sessions.getOrCreateSession).not.toHaveBeenCalled();
    } finally { await adapter.destroy(); }
  });
  it("reads only an existing live worker and whitelists model metadata", async () => {
    const f = bridgeFixture(), result = await f.bridge.getPiSession(scope);
    expect(result.session).toMatchObject({ model: "provider/model", thinking: "high", busy: true, ui: state.ui });
    expect(result.session?.token).not.toBe("native");
    expect(JSON.stringify(result)).not.toContain("MUST_NOT_LEAVE_HOST");
    expect(JSON.stringify(result)).not.toContain("private.invalid");
    expect(piSessionSnapshotSchema.safeParse(result).success).toBe(true);
    expect(f.controls.getState).not.toHaveBeenCalled();
    expect(f.sessions.getOrCreateSession).not.toHaveBeenCalled();
    expect(f.adapter.sendUserMessage).not.toHaveBeenCalled();
  });
  it("does not create or recover missing, retired or unsupported workers", async () => {
    const f = bridgeFixture(); f.bind("");
    expect(await f.bridge.getPiSession(scope)).toEqual({ supported: true });
    f.bind("native"); f.retire();
    expect(await f.bridge.getPiSession(scope)).toEqual({ supported: true });
    delete (f.controls as { getLiveSession?: unknown }).getLiveSession;
    expect(await f.bridge.getPiSession(scope)).toEqual({ supported: false });
    expect(f.sessions.getOrCreateSession).not.toHaveBeenCalled(); expect(f.controls.getState).not.toHaveBeenCalled();
  });
  it("discards a snapshot when its binding changes while reading", async () => {
    const f = bridgeFixture(); f.live.listModels.mockImplementation(async () => { f.bind("next"); return []; });
    expect(await f.bridge.getPiSession(scope)).toEqual({ supported: true });
  });
  it("does not inspect or control another conversation's active shared session", async () => {
    const f = bridgeFixture();
    (f.bridge as unknown as { sessionTurnOwners: Map<string, unknown> }).sessionTurnOwners.set("native", { scopeLockId: "another-conversation", lockedSessionId: "native", released: new Promise(() => {}) });
    expect(await f.bridge.getPiSession(scope)).toEqual({ supported: true });
    expect(await f.bridge.changePiSession({ ...scope, expectedSession: "old", action: "model", value: "provider/model" })).toEqual({ outcome: "rejected", reason: "stale" });
    expect(f.live.getState).not.toHaveBeenCalled(); expect(f.live.setModel).not.toHaveBeenCalled();
  });
  it("accepts model and thinking changes mid-run only for the exact token", async () => {
    const f = bridgeFixture(), snapshot = await f.bridge.getPiSession(scope), expectedSession = snapshot.session!.token;
    expect(await f.bridge.changePiSession({ ...scope, expectedSession, action: "model", value: "provider/model" })).toEqual({ outcome: "accepted" });
    expect(f.live.setModel).toHaveBeenCalledWith({ provider: "provider", modelId: "model" }, expect.objectContaining({ isCurrent: expect.any(Function) }));
    expect(await f.bridge.changePiSession({ ...scope, expectedSession, action: "thinking", value: null })).toEqual({ outcome: "accepted" });
    expect(f.live.setThinkingLevel).toHaveBeenCalledWith(null, expect.any(Object));
    expect(await f.bridge.changePiSession({ ...scope, expectedSession: "stale", action: "model", value: null })).toEqual({ outcome: "rejected", reason: "stale" });
    expect(f.live.setModel).toHaveBeenCalledTimes(1);
  });
  it("rejects a token borrowed from another conversation even for the same native session", async () => {
    const f = bridgeFixture(), snapshot = await f.bridge.getPiSession(scope);
    expect(await f.bridge.changePiSession({ ...scope, conversationKey: "lark:other", expectedSession: snapshot.session!.token, action: "model", value: null })).toEqual({ outcome: "rejected", reason: "stale" });
    expect(f.live.setModel).not.toHaveBeenCalled();
  });
  it("rechecks binding inside the native pre-write guard", async () => {
    const f = bridgeFixture(), snapshot = await f.bridge.getPiSession(scope);
    f.live.setModel.mockImplementation(async (_model, options) => { f.bind("other"); if (!await options.isCurrent()) throw new PiNativeRejectedError("stale", "not-found"); return state; });
    // The callback prevents this fake's write, but the boundary cannot infer
    // whether a real native setter reached an earlier write before its guard.
    expect(await f.bridge.changePiSession({ ...scope, expectedSession: snapshot.session!.token, action: "model", value: null })).toEqual({ outcome: "unknown", reason: "uncertain" });
  });
  it("reports uncertainty if ownership disappears after a model write", async () => {
    const f = bridgeFixture(), snapshot = await f.bridge.getPiSession(scope);
    f.live.setModel.mockImplementation(async () => { f.retire(); return state; });
    expect(await f.bridge.changePiSession({ ...scope, expectedSession: snapshot.session!.token, action: "model", value: null })).toEqual({ outcome: "unknown", reason: "uncertain" });
  });
  it("does not label a native write followed by a stale-handle error as rejected", async () => {
    const f = bridgeFixture(), snapshot = await f.bridge.getPiSession(scope);
    let applied = false;
    f.live.setModel.mockImplementation(async () => { applied = true; f.retire(); throw new PiNativeRejectedError("post-write worker guard", "not-found"); });
    expect(await f.bridge.changePiSession({ ...scope, expectedSession: snapshot.session!.token, action: "model", value: "provider/model" })).toEqual({ outcome: "unknown", reason: "uncertain" });
    expect(applied).toBe(true);
  });
  it("keeps uncertain clear-default failures separate from rejected explicit choices", async () => {
    const f = bridgeFixture(), snapshot = await f.bridge.getPiSession(scope);
    f.live.setModel.mockRejectedValue(new PiNativeUncertainError("set_model"));
    expect(await f.bridge.changePiSession({ ...scope, expectedSession: snapshot.session!.token, action: "model", value: null })).toEqual({ outcome: "unknown", reason: "uncertain" });
    f.live.setModel.mockRejectedValue(new PiNativeRejectedError("model unavailable before reset", "model-unavailable"));
    expect(await f.bridge.changePiSession({ ...scope, expectedSession: snapshot.session!.token, action: "model", value: null })).toEqual({ outcome: "rejected", reason: "invalid" });
    expect(await f.bridge.changePiSession({ ...scope, expectedSession: snapshot.session!.token, action: "model", value: "provider/model" })).toEqual({ outcome: "rejected", reason: "invalid" });
    f.live.setThinkingLevel.mockRejectedValue(new PiNativeRejectedError("Bot default is unsupported by this model", "thinking-unsupported"));
    expect(await f.bridge.changePiSession({ ...scope, expectedSession: snapshot.session!.token, action: "thinking", value: null })).toEqual({ outcome: "rejected", reason: "invalid" });
  });
  it("rejects malformed model or thinking choices before any native write", async () => {
    const f = bridgeFixture(), snapshot = await f.bridge.getPiSession(scope);
    for (const change of [{ action: "model" as const, value: "unqualified" }, { action: "thinking" as const, value: "unsupported" }]) {
      expect(await f.bridge.changePiSession({ ...scope, expectedSession: snapshot.session!.token, ...change })).toEqual({ outcome: "rejected", reason: "invalid" });
    }
    expect(f.live.setModel).not.toHaveBeenCalled(); expect(f.live.setThinkingLevel).not.toHaveBeenCalled();
  });
});

describe("Pi session gateway authorization and receipts", () => {
  it("leaves an old Hub's transport untouched when it does not advertise Pi controls", async () => {
    const f = await gatewayFixture(); f.channel.transport.capabilities = [];
    expect(await f.run("pi.session.get", { botId: "pi_bot", conversationId: "chat", userId: "owner" })).toEqual({ supported: false });
    expect(await f.run("pi.session.set", input)).toEqual({ outcome: "rejected", reason: "unsupported" });
    expect(f.channel.transport.requestLive).not.toHaveBeenCalled(); expect(f.bridge.changePiSession).not.toHaveBeenCalled();
  });
  it("requires the same Bot, authorized owner and current binding for reads and writes", async () => {
    const f = await gatewayFixture();
    expect(await f.run("pi.session.get", { botId: "other", conversationId: "chat", userId: "owner" })).toEqual({ supported: true });
    f.channel.transport.requestLive.mockResolvedValue({ allowed: false });
    expect(await f.run("pi.session.set", input)).toEqual({ outcome: "rejected", reason: "stale" });
    f.channel.transport.requestLive.mockResolvedValue({ allowed: true }); f.channel.canSteerConversation.mockResolvedValue(false);
    expect(await f.run("pi.session.set", input)).toEqual({ outcome: "rejected", reason: "stale" });
    expect(f.bridge.getPiSession).not.toHaveBeenCalled(); expect(f.bridge.changePiSession).not.toHaveBeenCalled();
  });
  it("rechecks authorization after reads", async () => {
    const f = await gatewayFixture(); f.channel.transport.requestLive.mockResolvedValueOnce({ allowed: true }).mockResolvedValue({ allowed: false });
    expect(await f.run("pi.session.get", { botId: "pi_bot", conversationId: "chat", userId: "owner" })).toEqual({ supported: true });
  });
  it("deduplicates concurrent requests and persisted retries", async () => {
    const f = await gatewayFixture();
    expect(await Promise.all([f.run("pi.session.set", input), f.run("pi.session.set", input)])).toEqual([{ outcome: "accepted" }, { outcome: "accepted" }]);
    expect(await f.create()("pi.session.set", input)).toEqual({ outcome: "accepted" });
    expect(f.bridge.changePiSession).toHaveBeenCalledTimes(1);
  });
  it("binds every mutation field to requestId, including after uncertainty", async () => {
    const f = await gatewayFixture(); f.bridge.changePiSession.mockRejectedValue(new Error("RPC timed out"));
    expect(await f.run("pi.session.set", input)).toEqual({ outcome: "unknown", reason: "uncertain" });
    expect(await f.create()("pi.session.set", input)).toEqual({ outcome: "unknown", reason: "uncertain" });
    for (const changed of [{ action: "thinking", value: "high" }, { value: null }, { expectedSession: "next" }, { conversationId: "other" }]) {
      expect(await f.run("pi.session.set", { ...input, ...changed })).toEqual({ outcome: "rejected", reason: "stale" });
    }
    expect(f.bridge.changePiSession).toHaveBeenCalledTimes(1);
  });
  it("does not return a prior receipt to a caller whose access was revoked", async () => {
    const f = await gatewayFixture(); await f.run("pi.session.set", input);
    f.channel.transport.requestLive.mockResolvedValue({ allowed: false });
    expect(await f.run("pi.session.set", input)).toEqual({ outcome: "rejected", reason: "stale" });
    expect(f.bridge.changePiSession).toHaveBeenCalledTimes(1);
  });
  it("reports unknown if access disappears after an admitted mutation", async () => {
    const f = await gatewayFixture(); f.bridge.changePiSession.mockImplementation(async () => { f.channel.transport.requestLive.mockResolvedValue({ allowed: false }); return { outcome: "accepted" }; });
    expect(await f.run("pi.session.set", input)).toEqual({ outcome: "unknown", reason: "uncertain" });
  });
  it("only accepts model/thinking controls, never replacement or reload", () => {
    for (const action of ["new", "fork", "reload", "bash"]) expect(piSessionChangeSchema.safeParse({ botId: "pi_bot", requestId: "r", expectedSession: "token", action, value: null }).success).toBe(false);
    expect(piSessionChangeSchema.safeParse({ botId: "pi_bot", requestId: "r", expectedSession: "token", action: "thinking", value: null }).success).toBe(true);
  });
});
