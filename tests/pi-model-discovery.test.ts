import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { access, stat } from "node:fs/promises";
import os from "node:os";
import { queryPiCatalog } from "../src/codex/pi-rpc-client.js";
import { discoverPiModels, resetPiModelDiscoveryForTest } from "../src/runtime/pi-model-discovery.js";
vi.mock("../src/codex/pi-rpc-client.js", () => ({ queryPiCatalog: vi.fn() }));
// Removal of the workspace-free directory can be made to fail the way it does while a process still runs in it.
const removal = vi.hoisted(() => ({ failures: 0, calls: 0 }));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rm: async (...args: Parameters<typeof actual.rm>) => {
    removal.calls++;
    if (removal.failures > 0) { removal.failures--; throw Object.assign(new Error("EBUSY: resource busy or locked, rmdir"), { code: "EBUSY" }); }
    return actual.rm(...args);
  } };
});
const query = vi.mocked(queryPiCatalog);
const env = { PI_EXECUTABLE: "/fixture/bin/pi", PI_CODING_AGENT_DIR: "/fixture/pi", OPEN_SUPER_AGENT_MODEL_DISCOVERY: "1" };
beforeEach(() => { resetPiModelDiscoveryForTest(); query.mockReset(); removal.failures = 0; removal.calls = 0; });
afterEach(() => { vi.useRealTimers(); });
describe("native Pi model discovery", () => {
  it("uses the native provider identity, supported thinking and default without exposing raw model config", async () => {
    query.mockResolvedValue({ models: [
      { provider: "first", id: "org/model:latest", name: "Shared name", reasoning: true, thinkingLevelMap: { xhigh: null, max: "max" }, headers: { Authorization: "not-for-client" } },
      { provider: "second", id: "org/model:latest", name: "Shared name", reasoning: false, baseUrl: "https://private.invalid" },
    ], current: { provider: "second", modelId: "org/model:latest", thinkingLevel: "off" } });
    const result = await discoverPiModels(env, "/fixture/project");
    expect(result).toMatchObject({ status: "ready", defaultModel: "second/org/model:latest", models: [
      { id: "first/org/model:latest", provider: "first", efforts: ["", "off", "minimal", "low", "medium", "high", "max"] },
      { id: "second/org/model:latest", provider: "second", efforts: ["", "off"] },
    ] });
    expect(JSON.stringify(result)).not.toMatch(/not-for-client|private.invalid|Authorization|baseUrl/);
    expect(query).toHaveBeenCalledWith({ launch: { command: env.PI_EXECUTABLE, args: [] }, env, cwd: "/fixture/project", extraArgs: ["--no-mcp"] });
  });
  it("distinguishes missing native authentication from a transport error, and preserves a retry path", async () => {
    query.mockResolvedValueOnce({ models: [] }).mockRejectedValueOnce(new Error("private native error"));
    expect(await discoverPiModels(env, "/one")).toEqual({ status: "no-models", models: [] });
    expect(await discoverPiModels(env, "/two")).toEqual({ status: "unavailable", models: [] });
    expect(await discoverPiModels({ ...env, OPEN_SUPER_AGENT_MODEL_DISCOVERY: "0" }, "/one")).toEqual({ status: "unavailable", models: [] });
    expect(query).toHaveBeenCalledTimes(2);
  });
  it("coalesces overlapping readers but separates workspace/config roots and refreshes recent login changes", async () => {
    vi.useFakeTimers();
    let finish!: (value: { models: [] }) => void;
    query.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue({ models: [] });
    const first = discoverPiModels(env, "/one"), second = discoverPiModels(env, "/one");
    expect(query).toHaveBeenCalledTimes(1); finish({ models: [] });
    await Promise.all([first, second]);
    await discoverPiModels(env, "/one"); expect(query).toHaveBeenCalledTimes(1);
    await discoverPiModels(env, "/two");
    await discoverPiModels({ ...env, PI_CODING_AGENT_DIR: "/different" }, "/one");
    expect(query).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(1001);
    await discoverPiModels(env, "/one"); expect(query).toHaveBeenCalledTimes(4);
  });
  it.each([false, true])("isolates workspace-free discovery and removes its directory after failure=%s", async failure => {
    let directory = "";
    query.mockImplementation(async input => {
      directory = input.cwd;
      expect(directory).not.toBe(os.tmpdir());
      const info = await stat(directory);
      expect(info.isDirectory()).toBe(true);
      if (process.platform !== "win32") expect(info.mode & 0o077).toBe(0);
      expect(input.extraArgs).toEqual(["--no-mcp"]);
      if (failure) throw new Error("unavailable");
      return { models: [] };
    });
    await Promise.all([discoverPiModels(env), discoverPiModels(env)]);
    expect(query).toHaveBeenCalledTimes(1);
    await expect(access(directory)).rejects.toThrow();
  });
  it("keeps a catalog it read when its directory cannot be removed yet, and removes it once it can", async () => {
    // Windows refuses to remove the working directory of a process that is still exiting (EBUSY); the
    // catalog process is closed in the background, so the first removal can come too early there.
    let directory = "";
    query.mockImplementation(async input => { directory = input.cwd; return { models: [{ provider: "first", id: "one", reasoning: false }] }; });
    removal.failures = 2;
    const result = await discoverPiModels(env);
    expect(result).toMatchObject({ status: "ready", models: [{ id: "first/one" }] });
    // The answer did not wait for the retries.
    expect(removal.calls).toBe(1);
    await stat(directory);
    await vi.waitFor(async () => { await expect(access(directory)).rejects.toThrow(); }, { timeout: 5_000, interval: 50 });
    expect(removal.calls).toBe(3);
  });
  it("stops retrying the removal after a bounded time", async () => {
    vi.useFakeTimers();
    let directory = "";
    query.mockImplementation(async input => { directory = input.cwd; return { models: [] }; });
    removal.failures = Number.POSITIVE_INFINITY;
    try {
      expect(await discoverPiModels(env)).toEqual({ status: "no-models", models: [] });
      await vi.advanceTimersByTimeAsync(60_000);
      const attempts = removal.calls;
      expect(attempts).toBeGreaterThan(5);
      expect(attempts).toBeLessThanOrEqual(60);
      await vi.advanceTimersByTimeAsync(600_000);
      expect(removal.calls).toBe(attempts);
    } finally {
      // Every removal was refused above, so the directory is still there: take it away for real.
      vi.useRealTimers();
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      if (directory) await actual.rm(directory, { recursive: true, force: true });
    }
    await expect(access(directory)).rejects.toThrow();
  });
});
