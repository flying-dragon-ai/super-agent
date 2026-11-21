import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crossSpawn from "cross-spawn";
import { afterEach, expect, it, vi } from "vitest";
import { deepseekDesktopLauncher, spawnEngine } from "../src/runtime/engine-process.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("cross-spawn", () => ({ default: vi.fn() }));

// Official Desktop dsh.cmd; these fixtures contain no installed/user paths.
const desktopShim = [
  "@echo off",
  "setlocal DisableDelayedExpansion",
  'set "ELECTRON_RUN_AS_NODE=1"',
  '"%~dp0..\\..\\..\\..\\DeepSeek Harness.exe" --expose-internals "%~dp0..\\..\\..\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js" %*',
  "exit /b %errorlevel%",
].join("\r\n") + "\r\n";

let directory: string | undefined;
afterEach(async () => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

async function fixture(body = desktopShim) {
  directory = await mkdtemp(path.join(os.tmpdir(), "dsh-desktop-launch-"));
  const root = path.join(directory, "Desktop & Unicode 示例");
  const shim = path.join(root, "resources", "runtime", "cli", "bin", "dsh.cmd");
  const executable = path.join(root, "DeepSeek Harness.exe");
  const archive = path.join(root, "resources", "app.asar");
  await mkdir(path.dirname(shim), { recursive: true });
  await writeFile(shim, body);
  // Inert files: tests inspect launch selection and never execute these bytes.
  await writeFile(executable, "");
  await writeFile(archive, "");
  return { shim, executable, archive, entrypoint: path.join(archive, "dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js") };
}

it("resolves the official Electron launcher with spaces and Unicode paths", async () => {
  const { shim, executable, entrypoint } = await fixture();
  expect(deepseekDesktopLauncher(shim)).toEqual({ executable, entrypoint });
});

it("accepts LF and a BOM without interpreting other batch commands", async () => {
  const { shim, executable, entrypoint } = await fixture("\uFEFF" + desktopShim.replace(/\r\n/g, "\n"));
  expect(deepseekDesktopLauncher(shim)).toEqual({ executable, entrypoint });
  await writeFile(shim, desktopShim + "echo custom setup\r\n");
  expect(deepseekDesktopLauncher(shim)).toBeUndefined();
});

it.each(["executable", "archive"] as const)("requires the Desktop %s to be a file", async missing => {
  const files = await fixture();
  await rm(files[missing]);
  await mkdir(files[missing]);
  expect(deepseekDesktopLauncher(files.shim)).toBeUndefined();
});

it("rejects missing, renamed, oversized and modified launchers", async () => {
  const { shim } = await fixture();
  expect(deepseekDesktopLauncher(shim + ".missing")).toBeUndefined();
  const renamed = path.join(path.dirname(shim), "custom.cmd");
  await writeFile(renamed, desktopShim);
  expect(deepseekDesktopLauncher(renamed)).toBeUndefined();
  await writeFile(shim, desktopShim + " ".repeat(16384));
  expect(deepseekDesktopLauncher(shim)).toBeUndefined();
  await writeFile(shim, desktopShim.replace("--expose-internals", "--inspect"));
  expect(deepseekDesktopLauncher(shim)).toBeUndefined();
});

it.skipIf(process.platform !== "win32")("preserves native pipe handles, runtime flags, environment and exact arguments", async () => {
  const { shim, executable, entrypoint } = await fixture();
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: "0", DSH_LAUNCH_FIXTURE: "retained" };
  const before = { ...env };
  const args = ["web", "--no-open", "--host", "127.0.0.1", "--port", "0", 'space & Unicode 示例 "quote"'];
  const options: SpawnOptions = { cwd: directory, env, stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"] };
  const child = {} as ChildProcess;
  vi.mocked(spawn).mockReturnValue(child);
  expect(spawnEngine(shim, args, options)).toBe(child);
  expect(spawn).toHaveBeenCalledExactlyOnceWith(executable, ["--expose-internals", entrypoint, ...args], {
    ...options, env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, shell: false, windowsHide: true,
  });
  expect(env).toEqual(before);
  expect(crossSpawn).not.toHaveBeenCalled();
});

it.skipIf(process.platform !== "win32")("inherits the process environment when the caller omits env", async () => {
  const { shim } = await fixture();
  vi.stubEnv("DSH_LAUNCH_FIXTURE", "inherited");
  spawnEngine(shim, [], {});
  expect(vi.mocked(spawn).mock.calls[0]?.[2]?.env).toMatchObject({ DSH_LAUNCH_FIXTURE: "inherited", ELECTRON_RUN_AS_NODE: "1" });
});

it.skipIf(process.platform !== "win32")("retains cross-spawn for custom batch launchers", async () => {
  const { shim } = await fixture("@echo off\r\necho custom launcher\r\n");
  const options: SpawnOptions = { env: { ...process.env } };
  const child = {} as ChildProcess;
  vi.mocked(crossSpawn).mockReturnValue(child);
  expect(spawnEngine(shim, ["web"], options)).toBe(child);
  expect(crossSpawn).toHaveBeenCalledExactlyOnceWith(shim, ["web"], { ...options, shell: false, windowsHide: true });
  expect(spawn).not.toHaveBeenCalled();
});

it.skipIf(process.platform !== "win32")("retains the bundled Node runtime for npm shims", async () => {
  const { shim } = await fixture();
  const entry = path.join(path.dirname(shim), "node_modules", "@example", "cli", "main.mjs");
  await mkdir(path.dirname(entry), { recursive: true });
  await writeFile(entry, "");
  await writeFile(shim, '@ECHO OFF\r\n"%_prog%" "%dp0%\\node_modules\\@example\\cli\\main.mjs" %*\r\n');
  spawnEngine(shim, ["web"], {});
  expect(spawn).toHaveBeenCalledExactlyOnceWith(process.execPath, [entry, "web"], { shell: false, windowsHide: true });
  expect(crossSpawn).not.toHaveBeenCalled();
});
