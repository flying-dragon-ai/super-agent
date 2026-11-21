import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { resolveBridgeConfig } from "../src/config.js";
import { inspectEngines } from "../src/host-cli/doctor.js";
import { hostProcessEnvironment } from "../src/host-cli/environment.js";
import { BotManager } from "../src/hub/bot-manager.js";
import { HubEngineSettings } from "../src/hub/engine-settings.js";
import { hostEngineEnvironment } from "../src/runtime/host-engine-settings.js";
import { resolveEngineExecutable } from "../src/runtime/engine-process.js";

let directory: string | undefined;
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); directory = undefined; });

// Real Windows filesystem/API fixture. Launchers are inert files and never
// executed; this does not claim Desktop Harness runtime or model acceptance.
it.skipIf(process.platform !== "win32")("keeps discovery, explicit settings and launch selection consistent on Windows", async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "dsh-discovery-"));
  const profile = path.join(directory, "profile"), host = path.join(directory, "host");
  await mkdir(host);
  const roaming = path.join(profile, "AppData", "Roaming"), local = path.join(profile, "AppData", "Local");
  const desktop = path.join(local, "Programs", "DeepSeek Harness", "resources", "runtime", "cli", "bin", "dsh.cmd");
  const npm = path.join(roaming, "npm", "dsh.cmd"), custom = path.join(directory, "manual CLI", "dsh.cmd");
  const create = async (file: string) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, "@echo off\r\nexit /b 91\r\n"); };
  const base = hostProcessEnvironment({ home: profile, executable: path.join(directory, "host-node", "node.exe"), env: { USERPROFILE: profile, HOME: profile, APPDATA: roaming, LOCALAPPDATA: local, PATH: "", PATHEXT: ".EXE;.CMD" } });
  const original = { ...base }, settings = new HubEngineSettings(host, () => base);
  const manager = new BotManager({} as never, host, { entrypoint: "unused", env: base }, () => "", async () => {});
  const check = (expected: string | null, source: "auto" | "setting" = "auto") => {
    const env = hostEngineEnvironment(host, base), row = settings.status().engines.find(item => item.id === "deepseek")!;
    const doctor = inspectEngines(env).find(item => item.engine === "deepseek")!;
    const command = resolveBridgeConfig(env).deepseekExecutable;
    expect([row.executable, doctor.executable, resolveEngineExecutable(command, env)].map(file => file?.toLowerCase() ?? null)).toEqual(Array(3).fill(expected?.toLowerCase() ?? null));
    expect(row.source).toBe(source);
    expect(manager.engineAvailable("deepseek")).toBe(expected !== null);
    expect(base).toEqual(original);
  };
  check(null);
  await create(desktop); check(desktop);
  await create(npm); check(npm);
  await create(custom);
  const saved = await settings.update({ engine: "deepseek", path: custom, revision: "default", requestId: "custom" }, apply => apply());
  check(custom, "setting");
  await rm(custom); check(null, "setting");
  await settings.update({ engine: "deepseek", path: null, revision: saved.revision, requestId: "reset" }, apply => apply());
  check(npm);
  await rm(npm); check(desktop);
  await rm(desktop); check(null);
});
