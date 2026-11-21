import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { HubEngineSettings } from "../src/hub/engine-settings.js";
import { engineSettingsFile, hostEngineEnvironment, readHostEngineSettings } from "../src/runtime/host-engine-settings.js";
import { engineSettingsCommand } from "../src/host-cli/engine-settings.js";
import { initializeHost } from "../src/host-cli/setup.js";
import { HubServer } from "../src/hub/server.js";
import { startHubControl } from "../src/hub/service.js";
import { LocalHostClient } from "../src/host-cli/client.js";
import { runHostCli } from "../src/host-cli/cli.js";
import { BotManager } from "../src/hub/bot-manager.js";
import { resolveBridgeConfig } from "../src/config.js";
import { inspectEngines } from "../src/host-cli/doctor.js";
import { buildHostEnvironment } from "../src/host-cli/environment.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "engine-settings-")); roots.push(root);
  const home = path.join(root, "home"); await mkdir(home);
  const executable = path.join(root, process.platform === "win32" ? "an engine.exe" : "an engine");
  await writeFile(executable, "a fixture, never executed"); await chmod(executable, 0o700);
  const env = { HOME: home, PATH: "/usr/bin:/bin", CODEX_EXECUTABLE: process.execPath, DSH_EXECUTABLE: process.execPath };
  const settings = new HubEngineSettings(root, () => env);
  return { root, home, executable, env, settings };
}
it("persists explicit paths without executing, and reset restores the original environment", async () => {
  const f = await fixture(), before = f.settings.status();
  expect(before.engines.find(e => e.id === "codex")).toMatchObject({ source: "environment", executable: process.execPath });
  const set = await f.settings.update({ engine: "codex", path: f.executable, requestId: "set", revision: before.revision }, apply => apply());
  expect(set.engines.find(e => e.id === "codex")).toMatchObject({ source: "setting", executable: f.executable });
  expect(new HubEngineSettings(f.root, () => f.env).status()).toEqual(set);
  expect(hostEngineEnvironment(f.root, f.env)).toMatchObject({ CODEX_EXECUTABLE: f.executable, DSH_EXECUTABLE: process.execPath });
  expect(f.env.CODEX_EXECUTABLE).toBe(process.execPath);
  const cleared = await f.settings.update({ engine: "codex", path: null, requestId: "reset", revision: set.revision }, apply => apply());
  expect(cleared.engines.find(e => e.id === "codex")).toMatchObject({ source: "environment", override: null, executable: process.execPath });
});
it("keeps saved DeepSeek paths ahead of environment defaults and fails closed after removal", async () => {
  const f = await fixture();
  await f.settings.update({ engine: "deepseek", path: f.executable, requestId: "dsh", revision: "default" }, apply => apply());
  const env = hostEngineEnvironment(f.root, f.env);
  expect(resolveBridgeConfig(env).deepseekExecutable).toBe(f.executable);
  expect(inspectEngines(env).find(row => row.engine === "deepseek")?.executable).toBe(f.executable);
  expect(f.settings.status().engines.find(row => row.id === "deepseek")).toMatchObject({ source: "setting", executable: f.executable });
  await rm(f.executable);
  expect(f.settings.status().engines.find(row => row.id === "deepseek")).toMatchObject({ source: "setting", available: false });
  expect(inspectEngines(env).find(row => row.engine === "deepseek")?.installed).toBe(false);
  expect(resolveBridgeConfig(env).deepseekExecutable).toBe(f.executable);
});
it("uses the same Pi executable for Host, Doctor and settings, without running a discovery candidate", async () => {
  const f = await fixture();
  const env = { ...f.env, PI_EXECUTABLE: process.execPath };
  const settings = new HubEngineSettings(f.root, () => env);
  const set = await settings.update({ engine: "pi", path: f.executable, requestId: "pi-set", revision: "default" }, apply => apply());
  const effective = hostEngineEnvironment(f.root, env);
  expect(resolveBridgeConfig(effective).piExecutable).toBe(f.executable);
  expect(inspectEngines(effective).find(row => row.engine === "pi")).toMatchObject({ executable: f.executable, installed: true, authentication: "unverified" });
  expect(settings.status().engines.find(row => row.id === "pi")).toMatchObject({ source: "setting", executable: f.executable, available: true });
  // The candidate is a non-program text file: discovery must never execute it.
  await rm(f.executable);
  expect(resolveBridgeConfig(effective).piExecutable).toBe(f.executable);
  expect(inspectEngines(effective).find(row => row.engine === "pi")?.installed).toBe(false);
  expect(settings.status().engines.find(row => row.id === "pi")).toMatchObject({ source: "setting", executable: null, available: false });
  await settings.update({ engine: "pi", path: null, requestId: "pi-clear", revision: set.revision }, apply => apply());
  expect(resolveBridgeConfig(hostEngineEnvironment(f.root, env)).piExecutable).toBe(process.execPath);
});
it.skipIf(process.platform === "win32")("does not apply Windows DeepSeek environment normalization on Unix", async () => {
  const f = await fixture(), env = { HOME: f.home, PATH: "", dsh_executable: f.executable };
  expect(hostEngineEnvironment(f.root, env)).toMatchObject({ dsh_executable: f.executable });
  expect(hostEngineEnvironment(f.root, env).DSH_EXECUTABLE).toBeUndefined();
  expect(() => buildHostEnvironment({ home: f.home, env: { ...env, DSH_EXECUTABLE: `"${f.executable}"` } })).toThrow("host_service_engine_override_absolute_path_required");
});
it("rejects invalid files and paths without changing the saved settings", async () => {
  const f = await fixture();
  for (const invalid of ["codex", "~/bin/codex", `"${f.executable}"`, f.root, path.join(f.root, "missing"), `${f.executable} --flag`, `${f.executable} `]) {
    await expect(f.settings.update({ engine: "codex", path: invalid, requestId: "bad", revision: "default" }, apply => apply())).rejects.toThrow(/engine_path_/);
  }
  if (process.platform !== "win32") {
    await chmod(f.executable, 0o600);
    await expect(f.settings.update({ engine: "codex", path: f.executable, requestId: "bad", revision: "default" }, apply => apply())).rejects.toThrow("engine_path_unavailable");
  }
  expect(f.settings.status().revision).toBe("default");
});
it("serializes writers, rejects stale edits and keeps receipt retries idempotent", async () => {
  const f = await fixture(), command = { engine: "codex" as const, path: f.executable, requestId: "first", revision: "default" };
  const first = await f.settings.update(command, apply => apply());
  expect(await f.settings.update(command, () => { throw new Error("no second write"); })).toEqual(first);
  await expect(f.settings.update({ ...command, path: null }, apply => apply())).rejects.toThrow("engine_request_conflict");
  await expect(f.settings.update({ ...command, requestId: "stale" }, apply => apply())).rejects.toThrow("engine_revision_conflict");
  await expect(f.settings.update({ ...command, requestId: "revoked", revision: first.revision, path: null }, () => { throw new Error("revoked"); })).rejects.toThrow("revoked");
  expect(f.settings.status()).toEqual(first);
  const other = new HubEngineSettings(f.root, () => f.env);
  const results = await Promise.allSettled([f.settings, other].map((settings, i) => settings.update({ ...command, engine: "kimi", requestId: `r_${i}`, revision: first.revision }, apply => apply())));
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
  expect(f.settings.status().engines.find(e => e.id === "codex")?.override).toBe(f.executable);
});
it("does not silently fall back after a stored path disappears or settings are damaged", async () => {
  const f = await fixture();
  await f.settings.update({ engine: "codex", path: f.executable, requestId: "set", revision: "default" }, apply => apply());
  await rm(f.executable);
  expect(f.settings.status().engines.find(e => e.id === "codex")).toMatchObject({ source: "setting", available: false, executable: null });
  await writeFile(engineSettingsFile(f.root), "broken");
  expect(() => hostEngineEnvironment(f.root, f.env)).toThrow("engine_settings_unavailable");
  expect(() => f.settings.status()).toThrow("engine_settings_unavailable");
  await rm(engineSettingsFile(f.root));
  if (process.platform !== "win32") { await symlink(path.join(f.root, "missing"), engineSettingsFile(f.root)); expect(() => readHostEngineSettings(f.root)).toThrow("engine_settings_unavailable"); }
});
it("uses the owner API from CLI, checks read-back, and keeps paths out of audit events", async () => {
  const f = await fixture(); await initializeHost(f.root, "Engine settings fixture");
  const hub = await HubServer.start({ stateDir: f.root, managedBots: { entrypoint: path.resolve("dist/src/index.js"), env: f.env } });
  const close = await startHubControl(f.root, { running: true, pid: process.pid, url: hub.url, instanceUrl: hub.instanceUrl, publicKey: hub.auth.publicKey }, () => {}, { enrollController: value => hub.enrollLocalController(value) });
  const client = await LocalHostClient.connect(f.root, { enroll: true });
  try {
    expect(client.ready.serverCapabilities).toContain("engines.settings.v1");
    const set = await engineSettingsCommand(client, "set", { engine: "codex", path: f.executable, revision: "default", requestId: "api-set" }, () => undefined);
    expect(set.engines.find(e => e.id === "codex")?.override).toBe(f.executable);
    expect(set.engines.some(e => e.id === "pi")).toBe(true);
    const legacy = await client.request<{ engines: { id: string }[] }>("/api/settings/engines");
    expect(legacy.engines.map(e => e.id).sort()).toEqual(["antigravity", "claude", "codex", "deepseek", "kimi"]);
    const legacyWrite = await client.request<{ revision: string; engines: { id: string }[] }>("/api/settings/engines", "PUT", { engine: "codex", path: f.executable, revision: set.revision, requestId: "legacy-noop" });
    expect(legacyWrite.engines.map(e => e.id).sort()).toEqual(["antigravity", "claude", "codex", "deepseek", "kimi"]);
    expect((await client.request<{ engines: { id: string; available: boolean }[] }>("/api/bots/catalog")).engines.find(e => e.id === "codex")?.available).toBe(true);
    const audit = await hub.store.db.all("SELECT detail_json FROM audit_log WHERE kind='engines.settings-updated'");
    expect(JSON.stringify(audit)).not.toContain(f.executable);
    const out = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await runHostCli(["engines", "status", "--state-dir", f.root, "--json"]);
    expect(JSON.parse(String(out.mock.calls.at(-1)?.[0])).revision).toBe(legacyWrite.revision);
    expect((await fetch(hub.url + "/api/settings/engines")).ok).toBe(false);
    await hub.store.db.run("UPDATE users SET role='member' WHERE id='owner'");
    await expect(client.request("/api/settings/engines")).rejects.toThrow();
    await expect(client.request("/api/settings/engines", "PUT", { engine: "codex", path: null, revision: set.revision, requestId: "member" })).rejects.toThrow();
    expect(f.settings.status().revision).toBe(legacyWrite.revision);
  } finally { client.close(); await close(); await hub.close(); }
});
it("never repeats an unconfirmed CLI write or pretends an old Host supports settings", async () => {
  const f = await fixture(), submitted = vi.fn();
  const request = vi.fn(async <T = unknown>(_route: string, method?: string): Promise<T> => (method === "PUT" ? {} : f.settings.status()) as T);
  await expect(engineSettingsCommand({ ready: { serverCapabilities: ["engines.settings.v1"] } as any, request: request as LocalHostClient["request"] }, "set", { engine: "codex", path: f.executable, revision: "default" }, submitted)).rejects.toThrow("尚未核实");
  expect(request.mock.calls.filter(c => c[1] === "PUT")).toHaveLength(1); expect(submitted).toHaveBeenCalledTimes(1);
  await expect(engineSettingsCommand({ ready: { serverCapabilities: [] } as any, request: request as LocalHostClient["request"] }, "status", {}, submitted)).rejects.toThrow("请更新主机");
});
it("passes saved paths to new workers, preserves running workers, and reapplies paths after restore", async () => {
  const f = await fixture(); await initializeHost(f.root, "Worker environment fixture");
  const entrypoint = path.join(f.root, "worker.cjs");
  await writeFile(entrypoint, `require('node:fs').writeFileSync(require('node:path').join(process.env.OPEN_SUPER_AGENT_STATE_DIR, 'observed.json'), JSON.stringify({ pid: process.pid, executable: process.env.CODEX_EXECUTABLE })); setInterval(() => {}, 1000); process.on('message', message => { if (message.type === 'shutdown.now') process.exit(0); });`);
  const hub = await HubServer.start({ stateDir: f.root });
  const options = { entrypoint, env: { ...f.env, OPEN_SUPER_AGENT_MODEL_DISCOVERY: "0" } };
  let manager = new BotManager(hub.store, f.root, options, () => hub.instanceUrl, async () => undefined);
  try {
    const bot = await manager.create("owner", { requestId: "worker", name: "Fixture", engine: "codex", model: "", effort: "", workspace: "" });
    const observed = () => readFile(path.join(f.root, "bots", bot.id, "observed.json"), "utf8").then(JSON.parse);
    await vi.waitFor(async () => expect(await observed()).toMatchObject({ executable: process.execPath }));
    const old = await observed();
    await f.settings.update({ engine: "codex", path: f.executable, requestId: "set", revision: "default" }, apply => apply());
    expect(await observed()).toEqual(old); expect(process.kill(old.pid, 0)).toBe(true);
    await manager.close();
    manager = new BotManager(hub.store, f.root, options, () => hub.instanceUrl, async () => undefined); await manager.restore();
    await vi.waitFor(async () => expect(await observed()).toMatchObject({ executable: f.executable }));
    expect((await observed()).pid).not.toBe(old.pid);
    await manager.close();
    await writeFile(engineSettingsFile(f.root), "broken");
    manager = new BotManager(hub.store, f.root, options, () => hub.instanceUrl, async () => undefined); await manager.restore();
    expect(manager.serviceStatus(bot.id).text).toContain("Engine path settings are unavailable");
  } finally { await manager.close(); await hub.close(); }
});

it("reports unreadable settings through the owner API without replacing the file", async () => {
  const f = await fixture(); await initializeHost(f.root, "Damaged settings fixture");
  const hub = await HubServer.start({ stateDir: f.root, managedBots: { entrypoint: path.resolve("dist/src/index.js"), env: f.env } });
  const close = await startHubControl(f.root, { running: true, pid: process.pid, url: hub.url, instanceUrl: hub.instanceUrl, publicKey: hub.auth.publicKey }, () => {}, { enrollController: value => hub.enrollLocalController(value) });
  const client = await LocalHostClient.connect(f.root, { enroll: true });
  try {
    for (const bytes of ["broken", JSON.stringify({ format: 2, revision: "future", paths: {}, receipts: [] }), JSON.stringify({ format: 1, revision: "trailing", paths: { codex: f.executable + " " }, receipts: [] })]) {
      await writeFile(engineSettingsFile(f.root), bytes, { mode: 0o600 });
      for (const [route, method, body] of [
        ["/api/settings/engines", "GET", undefined],
        ["/api/settings/engines", "PUT", { engine: "codex", path: f.executable, revision: "default", requestId: "repair" }],
        ["/api/bots/catalog", "GET", undefined],
        ["/api/bots", "POST", { requestId: "blocked", name: "Fixture", engine: "codex", model: "", effort: "", workspace: "" }],
      ] as const) await expect(client.request(route, method, body)).rejects.toMatchObject({ code: "engine_settings_unavailable", status: 503 });
      await expect(engineSettingsCommand(client, "status", {}, () => {})).rejects.toThrow("engine-settings.json");
      expect(await readFile(engineSettingsFile(f.root), "utf8")).toBe(bytes);
    }
  } finally { client.close(); await close(); await hub.close(); }
});
it("retains worker errors when a damaged settings file prevents automatic restart", async () => {
  const f = await fixture(); await initializeHost(f.root, "Worker log fixture");
  const entrypoint = path.join(f.root, "worker-log.cjs");
  await writeFile(entrypoint, `process.stderr.write('fixture stderr before restart\\n'); setInterval(() => {}, 1000); process.on('message', message => { if (message.type === 'shutdown.now') process.exit(0); });`);
  const hub = await HubServer.start({ stateDir: f.root });
  const manager = new BotManager(hub.store, f.root, { entrypoint, env: { ...f.env, OPEN_SUPER_AGENT_MODEL_DISCOVERY: "0" } }, () => hub.instanceUrl, async () => {});
  try {
    const bot = await manager.create("owner", { requestId: "log", name: "Fixture", engine: "codex", model: "", effort: "", workspace: "" });
    await vi.waitFor(() => expect(manager.serviceStatus(bot.id).text).toContain("fixture stderr before restart"));
    await writeFile(engineSettingsFile(f.root), "broken", { mode: 0o600 });
    const child = (manager as any).children.get(bot.id);
    child.kill();
    await vi.waitFor(() => expect(manager.serviceStatus(bot.id).text).toContain("Engine path settings are unavailable"), { timeout: 5000 });
    expect(manager.serviceStatus(bot.id).text).toContain("fixture stderr before restart");
  } finally { await manager.close(); await hub.close(); }
});

it("reports damaged engine settings, not a stopping Hub, when a stopped Bot is restarted", async () => {
  const f = await fixture(); await initializeHost(f.root, "Restart fixture");
  const entrypoint = path.join(f.root, "worker-restart.cjs");
  await writeFile(entrypoint, `setInterval(() => {}, 1000); process.on('message', message => { if (message.type === 'shutdown.now') process.exit(0); });`);
  const hub = await HubServer.start({ stateDir: f.root });
  const manager = new BotManager(hub.store, f.root, { entrypoint, env: { ...f.env, OPEN_SUPER_AGENT_MODEL_DISCOVERY: "0" } }, () => hub.instanceUrl, async () => {});
  try {
    const bot = await manager.create("owner", { requestId: "restart", name: "Fixture", engine: "codex", model: "", effort: "", workspace: "" });
    await vi.waitFor(() => expect((manager as any).children.get(bot.id)?.pid).toBeTruthy());
    await writeFile(engineSettingsFile(f.root), "broken", { mode: 0o600 });
    (manager as any).children.get(bot.id).kill();
    await vi.waitFor(() => expect(manager.serviceStatus(bot.id).text).toContain("Engine path settings are unavailable"), { timeout: 5000 });
    expect(await manager.restart(bot.id)).toEqual({ ok: false, error: "engine_settings_unavailable" });
    // The automatic retry stays armed, and the worker log keeps the reason.
    expect((manager as any).timers.has(bot.id)).toBe(true);
    expect(manager.serviceStatus(bot.id).text).toContain("Engine path settings are unavailable");
    // Once the owner repairs the file, the same manual restart starts the Bot.
    await rm(engineSettingsFile(f.root));
    expect(await manager.restart(bot.id)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect((manager as any).children.get(bot.id)?.pid).toBeTruthy());
  } finally { await manager.close(); await hub.close(); }
});
