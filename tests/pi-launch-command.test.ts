import { beforeEach, describe, expect, it, vi } from "vitest";

// Windows files are simulated: only these paths exist. Everything else falls through to the real fs.
const existing = new Set<string>();
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const missing = (file: string) => Object.assign(new Error(`ENOENT: ${file}`), { code: "ENOENT" });
  const simulated = (file: unknown) => typeof file === "string" && (file.includes("\\") || existing.has(file));
  const accessSync = ((file: string, mode?: number) => {
    if (!simulated(file)) return actual.accessSync(file, mode);
    if (!existing.has(file)) throw missing(file);
  }) as typeof actual.accessSync;
  const statSync = ((file: string, options?: unknown) => {
    if (!simulated(file)) return actual.statSync(file, options as never);
    if (!existing.has(file)) throw missing(file);
    return { isFile: () => true, size: 64 };
  }) as typeof actual.statSync;
  return { ...actual, default: { ...actual, accessSync, statSync }, accessSync, statSync };
});

import { resolvePiLaunchCommand } from "../src/runtime/pi-executable.js";

describe("Pi launch command on Windows", () => {
  beforeEach(() => existing.clear());
  const env = { Path: "C:\\Tools;.\\bin;relative;C:\\Program Files\\nodejs", PATHEXT: ".COM;.EXE;.BAT;.CMD" };

  it("never resolves a bare name through the workspace or a relative PATH entry", () => {
    // Where cmd.exe, libuv and cross-spawn's `which` would look first: the child's working directory.
    // path.win32.join turns the ".\\bin" entry into "bin\\pi.CMD".
    existing.add("pi.CMD"); existing.add("bin\\pi.CMD"); existing.add("relative\\pi.CMD");
    // A relative entry re-searched under an absolute directory is not a PATH match either.
    existing.add("C:\\Tools\\bin\\pi.CMD"); existing.add("C:\\Program Files\\nodejs\\relative\\pi.CMD");
    expect(resolvePiLaunchCommand("pi", env, "win32")).toBeUndefined();
  });

  it("returns the first absolute PATH match, honouring PATHEXT order", () => {
    existing.add("C:\\Program Files\\nodejs\\pi.CMD"); existing.add("C:\\Tools\\pi.EXE");
    expect(resolvePiLaunchCommand("pi", env, "win32")).toBe("C:\\Tools\\pi.EXE");
    existing.delete("C:\\Tools\\pi.EXE");
    expect(resolvePiLaunchCommand("pi", env, "win32")).toBe("C:\\Program Files\\nodejs\\pi.CMD");
  });

  it("keeps an explicit path as configured, even when it does not exist", () => {
    expect(resolvePiLaunchCommand("C:\\Users\\Example\\.pi\\agent\\bin\\pi.cmd", env, "win32")).toBe("C:\\Users\\Example\\.pi\\agent\\bin\\pi.cmd");
    expect(resolvePiLaunchCommand("D:/tools/pi.cmd", env, "win32")).toBe("D:/tools/pi.cmd");
  });

  it("rejects an empty command", () => {
    expect(resolvePiLaunchCommand("  ", env, "win32")).toBeUndefined();
  });
});
