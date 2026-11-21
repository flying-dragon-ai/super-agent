import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PiRpcAdapter } from "../src/codex/pi-rpc-adapter.js";
import { fakePiSpawner } from "./helpers/pi-fake-rpc.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-default-order-"));
  const configPath = path.join(root, "config.json");
  const config = (settings: { model?: string; effort?: string }) => writeFile(configPath,
    JSON.stringify({ engine: "pi", approvalMode: "bypass", ...settings }));
  await config({ model: "fakeprov/dup-model" });
  const spawner = fakePiSpawner();
  const adapter = new PiRpcAdapter({ launch: { command: "synthetic-pi", args: [] },
    stateDir: root, workspacePath: root, configPath, childEnv: {},
    bridgeExtensionPath: null, spawnFn: spawner.spawn, idleSweepIntervalMs: 0 });
  cleanups.push(async () => { await adapter.destroy(); await rm(root, { recursive: true, force: true }); });
  const { sessionId } = await adapter.createSession(1);
  const send = (text = "next") => adapter.sendUserMessage(sessionId, { text, authoredText: text, files: [], locale: "en" });
  await send("initial");
  const live = adapter.piNative.getLiveSession!(sessionId)!;
  return { config, configPath, send, live, spawner, adapter, sessionId };
}
const current = { isCurrent: async () => true };

describe("Pi Bot defaults and later conversation choices", () => {
  it("retains a newer thinking choice until that Bot default changes again", async () => {
    const f = await fixture();
    await f.config({ model: "fakeprov/dup-model", effort: "low" });
    await f.live.setThinkingLevel("high", current);
    await f.send(); await f.send();
    expect((await f.live.getState()).thinkingLevel).toBe("high");
    await f.config({ model: "fakeprov/dup-model", effort: "medium" });
    await f.send();
    expect((await f.live.getState()).thinkingLevel).toBe("medium");
  });

  it("retains a newer model choice until that Bot default changes again", async () => {
    const f = await fixture();
    await f.config({ model: "fakeprov2/dup-model" });
    await f.live.setModel({ provider: "fakeprov", modelId: "plain-model" }, current);
    await f.send(); await f.send();
    expect((await f.live.getState()).model).toMatchObject({ provider: "fakeprov", modelId: "plain-model" });
    await f.config({ model: "fakeprov/dup-model" });
    await f.send();
    expect((await f.live.getState()).model).toMatchObject({ provider: "fakeprov", modelId: "dup-model" });
  });

  it("acknowledges only the chosen field, including a choice already in place", async () => {
    const f = await fixture();
    await f.config({ model: "fakeprov2/dup-model", effort: "low" });
    await f.live.setModel({ provider: "fakeprov", modelId: "dup-model" }, current);
    await f.send();
    expect(await f.live.getState()).toMatchObject({ model: { provider: "fakeprov", modelId: "dup-model" }, thinkingLevel: "low" });
  });

  it("still applies a pending model default without replacing a newer thinking choice", async () => {
    const f = await fixture();
    await f.config({ model: "fakeprov2/dup-model", effort: "low" });
    await f.live.setThinkingLevel("high", current);
    await f.send();
    expect(await f.live.getState()).toMatchObject({ model: { provider: "fakeprov2", modelId: "dup-model" }, thinkingLevel: "high" });
  });

  it("does not acknowledge a default after a rejected conversation choice", async () => {
    const f = await fixture();
    await f.config({ model: "fakeprov/dup-model", effort: "low" });
    await expect(f.live.setThinkingLevel("max", current)).rejects.toThrow();
    await f.send();
    expect((await f.live.getState()).thinkingLevel).toBe("low");
  });

  it("does not consume a Bot default saved while the explicit native change is in flight", async () => {
    const f = await fixture();
    await f.config({ model: "fakeprov/dup-model", effort: "low" });
    let checks = 0;
    await f.live.setThinkingLevel("high", { isCurrent: async () => {
      // First check admits the choice. The next one guards its native write.
      if (++checks === 2) await f.config({ model: "fakeprov/dup-model", effort: "medium" });
      return true;
    } });
    expect((await f.live.getState()).thinkingLevel).toBe("high");
    await f.send();
    expect((await f.live.getState()).thinkingLevel).toBe("medium");
  });

  it("resetting thinking follows the current Bot effort without moving the conversation model", async () => {
    const f = await fixture();
    await f.live.setModel({ provider: "fakeprov2", modelId: "dup-model" }, current);
    await f.live.setThinkingLevel("high", current);
    await f.config({ model: "fakeprov/dup-model", effort: "low" });
    await f.live.setThinkingLevel(null, current);
    await f.send();
    expect(await f.live.getState()).toMatchObject({ model: { provider: "fakeprov2", modelId: "dup-model" }, thinkingLevel: "low" });
  });

  it.each(["/model fakeprov/dup-model", "/thinking off"])("allows %s to recover an incompatible Bot effort", async command => {
    const f = await fixture();
    await f.send("/model fakeprov/plain-model");
    await f.config({ model: "fakeprov/dup-model", effort: "high" });
    await expect(f.send()).rejects.toThrow();
    const prompts = f.spawner.last().received.filter(row => row.type === "prompt").length;
    const status = await f.send("/session");
    expect(status.text).toContain("Bot defaults could not be applied");
    const result = await f.send(command);
    expect(result.text).toContain("Bot defaults could not be applied");
    expect(f.spawner.last().received.filter(row => row.type === "prompt")).toHaveLength(prompts);
    await f.send("recovered");
    expect(f.spawner.last().received.filter(row => row.type === "prompt")).toHaveLength(prompts + 1);
  });

  it("does not turn an incompatible default into a model prompt or extension-command bypass", async () => {
    const f = await fixture();
    await f.send("/model fakeprov/plain-model");
    await f.config({ model: "fakeprov/dup-model", effort: "high" });
    const prompts = f.spawner.last().received.filter(row => row.type === "prompt").length;
    for (const text of ["ordinary message", "/session arguments", "/extension-command"]) {
      await expect(f.send(text)).rejects.toThrow();
    }
    expect(f.spawner.last().received.filter(row => row.type === "prompt")).toHaveLength(prompts);
  });

  it("does not bypass unreadable execution configuration for recovery commands", async () => {
    const f = await fixture();
    const before = f.spawner.last().received.length;
    // Configuration validation must still precede every control, even a local one.
    await writeFile(f.configPath, "{malformed configuration");
    for (const text of ["/model fakeprov2/dup-model", "/thinking off", "/session"]) {
      await expect(f.send(text)).rejects.toThrow();
    }
    const mutations = f.spawner.last().received.slice(before).filter(row => ["prompt", "set_model", "set_thinking_level"].includes(row.type));
    expect(mutations).toEqual([]);
  });
});
