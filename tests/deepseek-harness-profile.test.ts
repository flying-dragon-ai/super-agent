import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { prepareDeepSeekHarnessHome } from "../src/codex/deepseek-harness-host.js";
import { prepareDeepSeekHarnessPrivateProfile } from "../src/codex/deepseek-harness-profile.js";
import { removeTempRoot } from "./helpers/temp-files.js";

const fsCalls = vi.hoisted(() => ({
  symlinkTypes: [] as Array<string | undefined>,
  symlinkEpermForFiles: false,
  copyFailFor: new Set<string>(),
  copyFailOnceFor: new Set<string>(),
  beforeCopyFailure: undefined as (() => Promise<void>) | undefined,
  afterCopy: undefined as ((source: string) => void) | undefined,
  unlinkEpermFor: new Set<string>(),
  rmdir: [] as string[],
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    symlink: async (target: string, file: string, type?: string) => {
      fsCalls.symlinkTypes.push(type);
      // Synthetic Windows without the symbolic-link privilege: file links are refused.
      if (fsCalls.symlinkEpermForFiles && type === "file") {
        throw Object.assign(new Error(`EPERM: operation not permitted, symlink '${target}' -> '${file}'`), { code: "EPERM" });
      }
      return await actual.symlink(target, file, type as never);
    },
    // A copy that dies halfway: part of the destination is written, then it fails.
    copyFile: async (source: string, destination: string, mode?: number) => {
      if (fsCalls.copyFailOnceFor.delete(source) || fsCalls.copyFailFor.has(source)) {
        await fsCalls.beforeCopyFailure?.();
        await actual.writeFile(destination, "partial");
        throw Object.assign(new Error(`EIO: i/o error, copyfile '${source}' -> '${destination}'`), { code: "EIO" });
      }
      await actual.copyFile(source, destination, mode);
      fsCalls.afterCopy?.(source);
    },
    // Synthetic Windows: a directory junction refuses unlink and is removed by rmdir.
    unlink: async (file: string) => {
      if (fsCalls.unlinkEpermFor.has(file)) {
        throw Object.assign(new Error(`EPERM: operation not permitted, unlink '${file}'`), { code: "EPERM" });
      }
      return await actual.unlink(file);
    },
    rmdir: async (file: string) => {
      fsCalls.rmdir.push(file);
      if (fsCalls.unlinkEpermFor.delete(file)) return await actual.unlink(file);
      return await actual.rmdir(file);
    },
  };
});

vi.mock("../src/codex/deepseek-office-fonts.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/codex/deepseek-office-fonts.js")>(),
  readDeepSeekOfficeConfig: vi.fn(async () => "[]"),
}));

const roots: string[] = [];

afterEach(async () => {
  fsCalls.symlinkTypes.length = 0;
  fsCalls.symlinkEpermForFiles = false;
  fsCalls.copyFailFor.clear();
  fsCalls.copyFailOnceFor.clear();
  fsCalls.beforeCopyFailure = undefined;
  fsCalls.afterCopy = undefined;
  fsCalls.unlinkEpermFor.clear();
  fsCalls.rmdir.length = 0;
  await Promise.all(roots.splice(0).map((root) => removeTempRoot(root)));
});

const SHARED_PATCH = [
  "- id: agent-default-model",
  "  config:",
  "    provider: native-provider",
  "    model: native-model",
  "",
].join("\n");
const MANIFEST = ".open-super-agent-profile-mirror.json";
const STAGING = ".open-super-agent-profile-mirror.tmp";

interface Fixture {
  root: string;
  sharedHome: string;
  sharedProfile: string;
  stateDir: string;
  privateProfile: string;
  linkedPlugin: string;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "deepseek-harness-profile-"));
  roots.push(root);
  const sharedHome = path.join(root, "shared");
  const sharedProfile = path.join(sharedHome, "profiles", "web");
  const stateDir = path.join(root, "bot");
  const linkedPlugin = path.join(root, "dev", "linked-plugin");
  await mkdir(path.join(sharedProfile, "node_modules", "plugin-a", "dist"), { recursive: true });
  await mkdir(path.join(sharedProfile, "node_modules", "@scope", "plugin-b"), { recursive: true });
  await mkdir(path.join(sharedProfile, "node_modules", ".bin"), { recursive: true });
  await mkdir(path.join(sharedProfile, "extra-dir"), { recursive: true });
  await mkdir(path.join(sharedHome, "profiles", "other"), { recursive: true });
  await mkdir(linkedPlugin, { recursive: true });
  await writeFile(path.join(sharedHome, ".credentials.yaml"), "", { mode: 0o600 });
  await writeFile(path.join(sharedProfile, "cordis.patch.yml"), SHARED_PATCH, { mode: 0o600 });
  await writeFile(path.join(sharedProfile, "package.json"), '{"name":"dsh-profile-web"}\n');
  await writeFile(path.join(sharedProfile, "pnpm-workspace.yaml"), "packages:\n  - .\n");
  await writeFile(path.join(sharedProfile, "cordis.yml"), "[]\n");
  await writeFile(path.join(sharedProfile, "package.json.lock"), "123\n");
  await writeFile(path.join(sharedProfile, "cordis.patch.yml.abc123.tmp"), "partial\n");
  await writeFile(path.join(sharedProfile, "extra-dir", "local-plugin.js"), "export const local = true;\n");
  await writeFile(path.join(sharedProfile, "node_modules", ".modules.yaml"), "hoisted\n");
  await writeFile(path.join(sharedProfile, "node_modules", "plugin-a", "package.json"), '{"name":"plugin-a"}\n');
  await writeFile(path.join(sharedProfile, "node_modules", "plugin-a", "index.js"), "export {};\n");
  await writeFile(path.join(sharedProfile, "node_modules", "plugin-a", "dist", "tool.js"), "#!/usr/bin/env node\n", { mode: 0o755 });
  await writeFile(path.join(sharedProfile, "node_modules", "@scope", "plugin-b", "index.js"), "export {};\n");
  await writeFile(path.join(linkedPlugin, "index.js"), "export const linked = true;\n");
  // A package the user linked from a development directory, and a link that stays inside the profile.
  await symlink(linkedPlugin, path.join(sharedProfile, "node_modules", "linked-plugin"), "dir");
  await symlink("../plugin-a/dist/tool.js", path.join(sharedProfile, "node_modules", ".bin", "tool"), "file");
  await writeFile(path.join(sharedHome, "profiles", "other", "cordis.patch.yml"), "[]\n");
  return { root, sharedHome, sharedProfile, stateDir, privateProfile: path.join(stateDir, "dsh-home", "profiles", "web"), linkedPlugin };
}

/** Every entry under a tree, without following links, with content identity for files. */
async function tree(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(dir: string): Promise<void> {
    for (const name of (await readdir(dir)).sort()) {
      const full = path.join(dir, name);
      const info = await lstat(full);
      const key = path.relative(root, full);
      if (info.isSymbolicLink()) out[key] = `link:${await readlink(full)}`;
      else if (info.isDirectory()) {
        out[key] = "dir";
        await walk(full);
      } else {
        const digest = createHash("sha256").update(await readFile(full)).digest("hex");
        out[key] = `file:${digest}:${info.ino}:${info.mtimeMs}`;
      }
    }
  }
  await walk(root);
  return out;
}

/** dsh's writeFileAtomic: a sibling temp file renamed over the target. */
async function dshSaveDefault(patchPath: string, contents: string): Promise<void> {
  const temp = `${patchPath}.${randomUUID().slice(0, 12)}.tmp`;
  await writeFile(temp, contents, { mode: 0o600, flag: "wx" });
  await rename(temp, patchPath);
}

async function prepare(f: Fixture): Promise<string[]> {
  const diagnostics: string[] = [];
  await prepareDeepSeekHarnessHome({
    sharedHome: f.sharedHome,
    stateDir: f.stateDir,
    onDiagnostic: (message) => diagnostics.push(message),
  });
  return diagnostics;
}

describe("DeepSeek Harness private profile", () => {
  it("copies the profile and its packages as private files and never writes the shared home", async () => {
    const f = await fixture();
    const before = await tree(f.root);

    const prepared = await prepareDeepSeekHarnessHome({ sharedHome: f.sharedHome, stateDir: f.stateDir });

    const after = await tree(f.root);
    for (const key of Object.keys(after)) {
      if (key === "bot" || key.startsWith(`bot${path.sep}`)) delete after[key];
    }
    expect(after).toEqual(before);
    const privateProfiles = path.join(prepared.home, "profiles");
    expect((await lstat(privateProfiles)).isDirectory()).toBe(true);
    expect((await lstat(f.privateProfile)).isDirectory()).toBe(true);
    expect((await readdir(privateProfiles)).sort()).toEqual(["web"]);

    for (const name of ["cordis.patch.yml", "package.json", "pnpm-workspace.yaml"]) {
      const target = path.join(f.privateProfile, name);
      const info = await lstat(target);
      expect(info.isFile()).toBe(true);
      expect(info.mode & 0o777).toBe(0o600);
      expect(await readFile(target, "utf8")).toBe(await readFile(path.join(f.sharedProfile, name), "utf8"));
    }
    // dsh-owned boot, lock and temp files are not mirrored.
    for (const name of ["cordis.yml", "package.json.lock", "cordis.patch.yml.abc123.tmp"]) {
      await expect(lstat(path.join(f.privateProfile, name))).rejects.toMatchObject({ code: "ENOENT" });
    }

    // Every package is a real private directory, so its modules lie below the Bot's own profile.
    const modules = path.join(f.privateProfile, "node_modules");
    expect((await readdir(modules)).sort()).toEqual([".bin", ".modules.yaml", "@scope", "linked-plugin", "plugin-a"]);
    for (const relative of ["", "plugin-a", "plugin-a/dist", "@scope", "@scope/plugin-b", ".bin"]) {
      const info = await lstat(path.join(modules, relative));
      expect(info.isSymbolicLink()).toBe(false);
      expect(info.isDirectory()).toBe(true);
    }
    for (const relative of [".modules.yaml", "plugin-a/package.json", "plugin-a/index.js", "plugin-a/dist/tool.js", "@scope/plugin-b/index.js"]) {
      const info = await lstat(path.join(modules, relative));
      expect(info.isFile()).toBe(true);
      expect(await readFile(path.join(modules, relative), "utf8"))
        .toBe(await readFile(path.join(f.sharedProfile, "node_modules", relative), "utf8"));
    }
    expect((await lstat(path.join(modules, "plugin-a", "dist", "tool.js"))).mode & 0o777).toBe(0o700);
    expect((await lstat(path.join(modules, "plugin-a", "index.js"))).mode & 0o077).toBe(0);
    const localPlugin = path.join(f.privateProfile, "extra-dir", "local-plugin.js");
    expect((await lstat(path.join(f.privateProfile, "extra-dir"))).isDirectory()).toBe(true);
    expect((await lstat(localPlugin)).isFile()).toBe(true);

    // A link inside the profile points into the private copy; a link that leaves it still does.
    expect(await readlink(path.join(modules, ".bin", "tool"))).toBe(path.join(modules, "plugin-a", "dist", "tool.js"));
    expect(await readlink(path.join(modules, "linked-plugin"))).toBe(path.join(f.sharedProfile, "node_modules", "linked-plugin"));
    expect(await readFile(path.join(modules, "linked-plugin", "index.js"), "utf8")).toBe("export const linked = true;\n");
    expect((await lstat(path.join(f.privateProfile, MANIFEST))).mode & 0o777).toBe(0o600);
    await expect(lstat(path.join(f.privateProfile, STAGING))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps a Bot's saved default private and refreshes it one-way on the next start", async () => {
    const f = await fixture();
    const prepared = await prepareDeepSeekHarnessHome({ sharedHome: f.sharedHome, stateDir: f.stateDir });
    const privatePatch = path.join(f.privateProfile, "cordis.patch.yml");
    const sharedPatch = path.join(f.sharedProfile, "cordis.patch.yml");
    const sharedBefore = await tree(f.sharedHome);

    // Same length as the shared value: only the contents tell them apart.
    await dshSaveDefault(privatePatch, SHARED_PATCH.replace("native-model", "bot-model-xx"));

    expect(await tree(f.sharedHome)).toEqual(sharedBefore);
    expect(await readFile(sharedPatch, "utf8")).toBe(SHARED_PATCH);
    expect(await readFile(privatePatch, "utf8")).toContain("bot-model-xx");

    await prepareDeepSeekHarnessHome({ sharedHome: f.sharedHome, stateDir: f.stateDir });
    expect(await readFile(privatePatch, "utf8")).toBe(SHARED_PATCH);

    // The user changes the native default; the Bot adopts it at its next start.
    const nativeChange = SHARED_PATCH.replace("native-model", "native-model-2");
    await writeFile(sharedPatch, nativeChange);
    const sharedAfterNative = await tree(f.sharedHome);
    await prepareDeepSeekHarnessHome({ sharedHome: f.sharedHome, stateDir: f.stateDir });

    expect(await readFile(privatePatch, "utf8")).toBe(nativeChange);
    expect(await tree(f.sharedHome)).toEqual(sharedAfterNative);
    expect(prepared.home).toBe(path.join(f.stateDir, "dsh-home"));
  });

  it("migrates an existing Bot's profiles link without touching the shared profile", async () => {
    const f = await fixture();
    const privateHome = path.join(f.stateDir, "dsh-home");
    await mkdir(privateHome, { recursive: true });
    await symlink(path.join(f.sharedHome, "profiles"), path.join(privateHome, "profiles"), "dir");
    const before = await tree(f.sharedHome);

    await prepareDeepSeekHarnessHome({ sharedHome: f.sharedHome, stateDir: f.stateDir });

    expect(await tree(f.sharedHome)).toEqual(before);
    expect((await lstat(path.join(privateHome, "profiles"))).isSymbolicLink()).toBe(false);
    expect(await readFile(path.join(f.privateProfile, "cordis.patch.yml"), "utf8")).toBe(SHARED_PATCH);

    // A second start changes nothing: no file is rewritten and no link recreated.
    const privateLayout = await tree(path.join(privateHome, "profiles"));
    fsCalls.symlinkTypes.length = 0;
    await prepareDeepSeekHarnessHome({ sharedHome: f.sharedHome, stateDir: f.stateDir });
    expect(await tree(path.join(privateHome, "profiles"))).toEqual(privateLayout);
    expect(fsCalls.symlinkTypes.filter((type) => type === "dir" || type === "junction")).toEqual([]);
    expect(await tree(f.sharedHome)).toEqual(before);
  });

  it("migrates a Windows profiles junction by removing only the link (synthetic platform)", async () => {
    const f = await fixture();
    const privateHome = path.join(f.stateDir, "dsh-home");
    const oldLink = path.join(privateHome, "profiles");
    await mkdir(privateHome, { recursive: true });
    await symlink(path.join(f.sharedHome, "profiles"), oldLink, "dir");
    const before = await tree(f.sharedHome);
    fsCalls.unlinkEpermFor.add(oldLink);
    fsCalls.symlinkTypes.length = 0;
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    try {
      await prepareDeepSeekHarnessPrivateProfile({ sharedHome: f.sharedHome, privateHome });
    } finally {
      Object.defineProperty(process, "platform", platform);
    }

    // rmdir removed the junction itself and, afterwards, only this start's own empty staging directory.
    expect(fsCalls.rmdir).toEqual([oldLink, path.join(f.privateProfile, STAGING)]);
    // Directory links are junctions on Windows; only the user's own linked package needs one.
    expect(fsCalls.symlinkTypes.sort()).toEqual(["file", "junction"]);
    expect(await tree(f.sharedHome)).toEqual(before);
    expect((await lstat(oldLink)).isDirectory()).toBe(true);
    expect((await lstat(oldLink)).isSymbolicLink()).toBe(false);
    expect((await lstat(path.join(f.privateProfile, "package.json"))).isFile()).toBe(true);
    expect((await lstat(path.join(f.privateProfile, "node_modules", "plugin-a"))).isSymbolicLink()).toBe(false);
  });

  it("copies a linked file when Windows refuses file links (synthetic platform)", async () => {
    const f = await fixture();
    await mkdir(path.join(f.stateDir, "dsh-home"), { recursive: true });
    const before = await tree(f.sharedHome);
    fsCalls.symlinkEpermForFiles = true;
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    try {
      await prepareDeepSeekHarnessPrivateProfile({ sharedHome: f.sharedHome, privateHome: path.join(f.stateDir, "dsh-home") });
      await prepareDeepSeekHarnessPrivateProfile({ sharedHome: f.sharedHome, privateHome: path.join(f.stateDir, "dsh-home") });
    } finally {
      Object.defineProperty(process, "platform", platform);
    }

    const tool = path.join(f.privateProfile, "node_modules", ".bin", "tool");
    expect((await lstat(tool)).isFile()).toBe(true);
    expect(await readFile(tool, "utf8")).toBe("#!/usr/bin/env node\n");
    expect(await tree(f.sharedHome)).toEqual(before);
  });

  it("migrates the earlier per-package links to private copies", async () => {
    const f = await fixture();
    const modules = path.join(f.privateProfile, "node_modules");
    await mkdir(path.join(modules, "@scope"), { recursive: true });
    await mkdir(path.join(modules, "@gone"), { recursive: true });
    const sharedModules = path.join(f.sharedProfile, "node_modules");
    await symlink(path.join(sharedModules, "plugin-a"), path.join(modules, "plugin-a"), "dir");
    await symlink(path.join(sharedModules, "@scope", "plugin-b"), path.join(modules, "@scope", "plugin-b"), "dir");
    await symlink(path.join(sharedModules, ".bin"), path.join(modules, ".bin"), "dir");
    await symlink(path.join(sharedModules, "removed-plugin"), path.join(modules, "removed-plugin"), "dir");
    await symlink(path.join(sharedModules, "@gone", "plugin"), path.join(modules, "@gone", "plugin"), "dir");
    await symlink(path.join(f.sharedProfile, "extra-dir"), path.join(f.privateProfile, "extra-dir"), "dir");
    await symlink(path.join(f.sharedProfile, "removed-dir"), path.join(f.privateProfile, "removed-dir"), "dir");
    const before = await tree(f.sharedHome);

    const diagnostics = await prepare(f);

    expect(await tree(f.sharedHome)).toEqual(before);
    expect(diagnostics).toEqual([]);
    expect((await readdir(modules)).sort()).toEqual([".bin", ".modules.yaml", "@scope", "linked-plugin", "plugin-a"]);
    for (const relative of ["plugin-a", "@scope/plugin-b", ".bin"]) {
      expect((await lstat(path.join(modules, relative))).isSymbolicLink()).toBe(false);
    }
    expect((await lstat(path.join(modules, "plugin-a", "index.js"))).isFile()).toBe(true);
    expect((await lstat(path.join(f.privateProfile, "extra-dir"))).isSymbolicLink()).toBe(false);
    await expect(lstat(path.join(f.privateProfile, "removed-dir"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refreshes changed package files and restores a private edit, leaving the rest untouched", async () => {
    const f = await fixture();
    await prepare(f);
    const modules = path.join(f.privateProfile, "node_modules");
    const untouched = await lstat(path.join(modules, "@scope", "plugin-b", "index.js"));

    // Same size, new time: the package was reinstalled.
    const sharedIndex = path.join(f.sharedProfile, "node_modules", "plugin-a", "index.js");
    await writeFile(sharedIndex, "export []\n");
    const later = new Date(Date.now() + 5_000);
    await utimes(sharedIndex, later, later);
    // Something edited the Bot's own copy without changing its size.
    const privateTool = path.join(modules, "plugin-a", "dist", "tool.js");
    await writeFile(privateTool, "#!/usr/bin/env bash\n");
    const privateLater = new Date(Date.now() + 9_000);
    await utimes(privateTool, privateLater, privateLater);
    const before = await tree(f.sharedHome);

    await prepare(f);

    expect(await readFile(path.join(modules, "plugin-a", "index.js"), "utf8")).toBe("export []\n");
    expect(await readFile(privateTool, "utf8")).toBe("#!/usr/bin/env node\n");
    const kept = await lstat(path.join(modules, "@scope", "plugin-b", "index.js"));
    expect([kept.ino, kept.mtimeMs]).toEqual([untouched.ino, untouched.mtimeMs]);
    expect(await tree(f.sharedHome)).toEqual(before);
  });

  it("drops entries the shared profile no longer has and keeps unexpected private data", async () => {
    const f = await fixture();
    await writeFile(path.join(f.sharedProfile, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
    await prepareDeepSeekHarnessHome({ sharedHome: f.sharedHome, stateDir: f.stateDir });
    const modules = path.join(f.privateProfile, "node_modules");
    await mkdir(path.join(modules, "local-only"), { recursive: true });
    await writeFile(path.join(modules, "local-only", "keep.txt"), "private\n");
    await writeFile(path.join(modules, "@scope", "plugin-b", "private-note.txt"), "private\n");
    await writeFile(path.join(f.privateProfile, "cordis.yml"), "[]\n");
    await writeFile(path.join(f.privateProfile, "runtime-state.json"), "{}\n");

    await rm(path.join(f.sharedProfile, "node_modules", "plugin-a"), { recursive: true });
    await rm(path.join(f.sharedProfile, "node_modules", ".bin", "tool"));
    await rm(path.join(f.sharedProfile, "node_modules", "@scope"), { recursive: true });
    await rm(path.join(f.sharedProfile, "node_modules", "linked-plugin"));
    await rm(path.join(f.sharedProfile, "pnpm-lock.yaml"));
    await rm(path.join(f.sharedProfile, "extra-dir"), { recursive: true });
    const before = await tree(f.sharedHome);
    const linkedBefore = await tree(f.linkedPlugin);
    const diagnostics = await prepare(f);

    expect(await tree(f.sharedHome)).toEqual(before);
    // The user's development directory behind the removed link is untouched.
    expect(await tree(f.linkedPlugin)).toEqual(linkedBefore);
    expect(await readFile(path.join(f.linkedPlugin, "index.js"), "utf8")).toBe("export const linked = true;\n");
    expect((await readdir(modules)).sort()).toEqual([".bin", ".modules.yaml", "@scope", "local-only"]);
    expect(await readdir(path.join(modules, ".bin"))).toEqual([]);
    // What this Bot's profile gained on its own stays, and is reported.
    expect(await readdir(path.join(modules, "@scope", "plugin-b"))).toEqual(["private-note.txt"]);
    expect(await readFile(path.join(modules, "local-only", "keep.txt"), "utf8")).toBe("private\n");
    expect(await readFile(path.join(f.privateProfile, "runtime-state.json"), "utf8")).toBe("{}\n");
    for (const kept of [path.join(modules, "local-only"), path.join(modules, "@scope", "plugin-b"), path.join(f.privateProfile, "runtime-state.json")]) {
      expect(diagnostics.filter((line) => line.endsWith(`: ${kept}`))).toHaveLength(1);
    }
    for (const name of ["pnpm-lock.yaml", "extra-dir"]) {
      await expect(lstat(path.join(f.privateProfile, name))).rejects.toMatchObject({ code: "ENOENT" });
    }
    // dsh's own boot file is left alone.
    expect(await readFile(path.join(f.privateProfile, "cordis.yml"), "utf8")).toBe("[]\n");
  });

  it("follows a package path that turns from a directory into a file and back", async () => {
    const f = await fixture();
    await prepare(f);
    const sharedDist = path.join(f.sharedProfile, "node_modules", "plugin-a", "dist");
    const privateDist = path.join(f.privateProfile, "node_modules", "plugin-a", "dist");
    await rm(path.join(f.sharedProfile, "node_modules", ".bin", "tool"));
    await rm(sharedDist, { recursive: true });
    await writeFile(sharedDist, "export const bundled = true;\n");

    expect(await prepare(f)).toEqual([]);
    expect((await lstat(privateDist)).isFile()).toBe(true);
    expect(await readFile(privateDist, "utf8")).toBe("export const bundled = true;\n");

    await rm(sharedDist);
    await mkdir(sharedDist);
    await writeFile(path.join(sharedDist, "tool.js"), "export const tool = 2;\n");
    const before = await tree(f.sharedHome);

    expect(await prepare(f)).toEqual([]);
    expect(await readFile(path.join(privateDist, "tool.js"), "utf8")).toBe("export const tool = 2;\n");
    expect(await tree(f.sharedHome)).toEqual(before);
  });

  it("never deletes through a link that took the place of a private directory", async () => {
    const f = await fixture();
    await prepare(f);
    const modules = path.join(f.privateProfile, "node_modules");
    // The same file names exist in an unrelated directory, in another shared
    // profile, and behind a link deeper inside a package.
    const unrelated = path.join(f.root, "unrelated");
    const unrelatedDeep = path.join(f.root, "unrelated-deep");
    const sharedOther = path.join(f.sharedHome, "profiles", "other");
    await mkdir(path.join(unrelated, "dist"), { recursive: true });
    await mkdir(path.join(sharedOther, "plugin-b"), { recursive: true });
    await mkdir(unrelatedDeep, { recursive: true });
    await writeFile(path.join(unrelated, "package.json"), "UNRELATED\n");
    await writeFile(path.join(unrelated, "index.js"), "UNRELATED\n");
    await writeFile(path.join(unrelated, "dist", "tool.js"), "UNRELATED\n");
    await writeFile(path.join(sharedOther, "plugin-b", "index.js"), "SHARED OTHER\n");
    await writeFile(path.join(unrelatedDeep, "local-plugin.js"), "UNRELATED DEEP\n");
    await mkdir(path.join(f.sharedProfile, "extra-dir", "inner"));
    await writeFile(path.join(f.sharedProfile, "extra-dir", "inner", "local-plugin.js"), "export const inner = true;\n");
    await prepare(f);

    await rm(path.join(modules, "plugin-a"), { recursive: true });
    await symlink(unrelated, path.join(modules, "plugin-a"), "dir");
    await rm(path.join(modules, "@scope"), { recursive: true });
    await symlink(sharedOther, path.join(modules, "@scope"), "dir");
    await rm(path.join(f.privateProfile, "extra-dir", "inner"), { recursive: true });
    await symlink(unrelatedDeep, path.join(f.privateProfile, "extra-dir", "inner"), "dir");
    // The shared profile drops all three, so every recorded path below them is stale.
    await rm(path.join(f.sharedProfile, "node_modules", "plugin-a"), { recursive: true });
    await rm(path.join(f.sharedProfile, "node_modules", ".bin", "tool"));
    await rm(path.join(f.sharedProfile, "node_modules", "@scope"), { recursive: true });
    await rm(path.join(f.sharedProfile, "extra-dir"), { recursive: true });
    const before = { shared: await tree(f.sharedHome), unrelated: await tree(unrelated), deep: await tree(unrelatedDeep) };

    await prepare(f);

    expect({ shared: await tree(f.sharedHome), unrelated: await tree(unrelated), deep: await tree(unrelatedDeep) }).toEqual(before);
    // Only the links themselves are gone.
    for (const link of [path.join(modules, "plugin-a"), path.join(modules, "@scope"), path.join(f.privateProfile, "extra-dir")]) {
      await expect(lstat(link)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("rebuilds a private directory a link replaced without writing through the link", async () => {
    const f = await fixture();
    await prepare(f);
    const modules = path.join(f.privateProfile, "node_modules");
    const unrelated = path.join(f.root, "unrelated");
    await mkdir(path.join(unrelated, "dist"), { recursive: true });
    await writeFile(path.join(unrelated, "package.json"), "UNRELATED\n");
    await writeFile(path.join(unrelated, "index.js"), "UNRELATED\n");
    await writeFile(path.join(unrelated, "dist", "tool.js"), "UNRELATED\n");
    await rm(path.join(modules, "plugin-a"), { recursive: true });
    await symlink(unrelated, path.join(modules, "plugin-a"), "dir");
    // The shared package also changed, so its files must be copied again.
    await writeFile(path.join(f.sharedProfile, "node_modules", "plugin-a", "index.js"), "export const changed = true;\n");
    const before = { shared: await tree(f.sharedHome), unrelated: await tree(unrelated) };

    await prepare(f);

    expect({ shared: await tree(f.sharedHome), unrelated: await tree(unrelated) }).toEqual(before);
    expect((await lstat(path.join(modules, "plugin-a"))).isSymbolicLink()).toBe(false);
    expect(await readFile(path.join(modules, "plugin-a", "index.js"), "utf8")).toBe("export const changed = true;\n");
    expect(await readFile(path.join(modules, "plugin-a", "dist", "tool.js"), "utf8")).toBe("#!/usr/bin/env node\n");
  });

  it("follows a shared package the user replaced with a link, leaving the linked directory alone", async () => {
    const f = await fixture();
    await prepare(f);
    const modules = path.join(f.privateProfile, "node_modules");
    const development = path.join(f.root, "dev", "plugin-a");
    await mkdir(path.join(development, "dist"), { recursive: true });
    await writeFile(path.join(development, "package.json"), '{"name":"plugin-a","version":"2.0.0-dev"}\n');
    await writeFile(path.join(development, "index.js"), "export const dev = true;\n");
    await writeFile(path.join(development, "dist", "tool.js"), "#!/usr/bin/env node\n// dev\n");
    const sharedPackage = path.join(f.sharedProfile, "node_modules", "plugin-a");
    await rm(sharedPackage, { recursive: true });
    await symlink(development, sharedPackage, "dir");
    const before = { shared: await tree(f.sharedHome), development: await tree(development) };

    expect(await prepare(f)).toEqual([]);

    expect({ shared: await tree(f.sharedHome), development: await tree(development) }).toEqual(before);
    expect(await readlink(path.join(modules, "plugin-a"))).toBe(sharedPackage);
    expect(await readFile(path.join(modules, "plugin-a", "index.js"), "utf8")).toBe("export const dev = true;\n");

    // And back to an installed copy.
    await rm(sharedPackage);
    await mkdir(sharedPackage);
    await writeFile(path.join(sharedPackage, "index.js"), "export const installed = true;\n");
    const developmentBefore = await tree(development);
    expect(await prepare(f)).toEqual([]);
    expect(await tree(development)).toEqual(developmentBefore);
    expect((await lstat(path.join(modules, "plugin-a"))).isSymbolicLink()).toBe(false);
    expect((await readdir(path.join(modules, "plugin-a"))).sort()).toEqual(["index.js"]);
  });

  it("keeps the old file whole when a copy fails and leaves no partial one", async () => {
    const f = await fixture();
    await prepare(f);
    const privatePatch = path.join(f.privateProfile, "cordis.patch.yml");
    const sharedPatch = path.join(f.sharedProfile, "cordis.patch.yml");
    const privateIndex = path.join(f.privateProfile, "node_modules", "plugin-a", "index.js");
    const sharedIndex = path.join(f.sharedProfile, "node_modules", "plugin-a", "index.js");
    const botChoice = SHARED_PATCH.replace("native-model", "bot-model");
    await dshSaveDefault(privatePatch, botChoice);
    const nativeChange = SHARED_PATCH.replace("native-model", "native-model-2");
    await writeFile(sharedPatch, nativeChange);
    await writeFile(sharedIndex, "export const version = 2;\n");
    fsCalls.copyFailFor.add(sharedPatch);
    fsCalls.copyFailFor.add(sharedIndex);
    const before = await tree(f.sharedHome);

    await expect(prepareDeepSeekHarnessHome({ sharedHome: f.sharedHome, stateDir: f.stateDir })).rejects.toThrow(/EIO/);

    // Neither file is missing or half written; each still holds what it held.
    expect(await readFile(privatePatch, "utf8")).toBe(botChoice);
    expect(await readFile(privateIndex, "utf8")).toBe("export {};\n");
    const leftovers = Object.entries(await tree(f.privateProfile))
      .filter(([key, value]) => value.startsWith("file:") && (key.startsWith(STAGING) || key.endsWith(".tmp")));
    expect(leftovers).toEqual([]);
    expect(await tree(f.sharedHome)).toEqual(before);

    fsCalls.copyFailFor.clear();
    await prepare(f);
    expect(await readFile(privatePatch, "utf8")).toBe(nativeChange);
    expect(await readFile(privateIndex, "utf8")).toBe("export const version = 2;\n");
    await expect(lstat(path.join(f.privateProfile, STAGING))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("lets overlapping starts of one Bot take turns", async () => {
    const f = await fixture();
    const before = await tree(f.sharedHome);

    const first = await Promise.allSettled([prepare(f), prepare(f), prepare(f)]);
    expect(first.map((result) => result.status)).toEqual(["fulfilled", "fulfilled", "fulfilled"]);

    // Again with something to refresh, and with one of the starts failing.
    await dshSaveDefault(path.join(f.privateProfile, "cordis.patch.yml"), SHARED_PATCH.replace("native-model", "bot-model"));
    const sharedIndex = path.join(f.sharedProfile, "node_modules", "plugin-a", "index.js");
    // Exactly one copy fails. Clearing a persistent fault from an outer
    // rejection callback races the next lock holder on slower CI machines.
    fsCalls.copyFailOnceFor.add(path.join(f.sharedProfile, "cordis.patch.yml"));
    const failing = prepare(f);
    const queued = prepare(f);
    // Observe both rejections immediately, not after waiting for the first.
    const results = await Promise.allSettled([failing, queued]);
    // Async path checks precede the lock, so invocation order is not lock
    // admission order. Exactly one attempt fails and the other recovers.
    expect(results.filter(result => result.status === "rejected"))
      .toEqual([expect.objectContaining({ status: "rejected", reason: expect.objectContaining({ code: "EIO" }) })]);
    expect(results.filter(result => result.status === "fulfilled"))
      .toEqual([{ status: "fulfilled", value: [] }]);

    expect(await readFile(path.join(f.privateProfile, "cordis.patch.yml"), "utf8")).toBe(SHARED_PATCH);
    expect(await readFile(path.join(f.privateProfile, "node_modules", "plugin-a", "index.js"), "utf8"))
      .toBe(await readFile(sharedIndex, "utf8"));
    await expect(lstat(path.join(f.privateProfile, STAGING))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await tree(f.sharedHome)).toEqual(before);
  });

  it("clears what an interrupted start left in its staging directory", async () => {
    const f = await fixture();
    await prepare(f);
    const staging = path.join(f.privateProfile, STAGING);
    await mkdir(staging);
    await writeFile(path.join(staging, "3.tmp"), "partial");
    await symlink(path.join(f.sharedProfile, "package.json"), path.join(staging, "4.tmp"), "file");
    const before = await tree(f.sharedHome);

    expect(await prepare(f)).toEqual([]);

    await expect(lstat(staging)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await tree(f.sharedHome)).toEqual(before);
  });

  it("removes only entries its own manifest names inside the private profile", async () => {
    const f = await fixture();
    await prepare(f);
    const outside = path.join(f.stateDir, "dsh-home", "outside.txt");
    const outsideDir = path.join(f.root, "elsewhere");
    await writeFile(outside, "keep\n");
    await mkdir(outsideDir);
    await writeFile(path.join(f.privateProfile, MANIFEST), JSON.stringify({
      version: 1,
      entries: {
        "../../outside.txt": { kind: "file" },
        [outside]: { kind: "file" },
        "node_modules/../../../outside.txt": { kind: "file" },
        [outsideDir]: { kind: "dir" },
        [MANIFEST]: { kind: "file" },
        [`${STAGING}/x`]: { kind: "file" },
        "node_modules/plugin-a/index.js": { kind: "file" },
      },
    }));
    const before = await tree(f.sharedHome);

    await prepare(f);

    expect(await readFile(outside, "utf8")).toBe("keep\n");
    expect((await lstat(outsideDir)).isDirectory()).toBe(true);
    expect(await tree(f.sharedHome)).toEqual(before);
    const manifest = JSON.parse(await readFile(path.join(f.privateProfile, MANIFEST), "utf8")) as { entries: Record<string, unknown> };
    expect(Object.keys(manifest.entries).filter((key) => key.includes("..") || path.isAbsolute(key))).toEqual([]);
    expect(manifest.entries["node_modules/plugin-a/index.js"]).toMatchObject({ kind: "file" });
  });

  it("copies a relocated package directory and keeps its inner links inside the private copy", async () => {
    const f = await fixture();
    const store = path.join(f.root, "store", "modules");
    await mkdir(path.dirname(store), { recursive: true });
    await rename(path.join(f.sharedProfile, "node_modules"), store);
    await symlink(store, path.join(f.sharedProfile, "node_modules"), "dir");
    const before = await tree(f.root);

    await prepare(f);

    const after = await tree(f.root);
    for (const key of Object.keys(after)) {
      if (key === "bot" || key.startsWith(`bot${path.sep}`)) delete after[key];
    }
    expect(after).toEqual(before);
    const modules = path.join(f.privateProfile, "node_modules");
    expect((await lstat(modules)).isSymbolicLink()).toBe(false);
    expect((await lstat(path.join(modules, "plugin-a", "index.js"))).isFile()).toBe(true);
    expect(await readlink(path.join(modules, ".bin", "tool"))).toBe(path.join(modules, "plugin-a", "dist", "tool.js"));
  });

  it("leaves a missing shared web profile for dsh to initialize privately", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "deepseek-harness-profile-empty-"));
    roots.push(root);
    const sharedHome = path.join(root, "shared");
    await mkdir(path.join(sharedHome, "profiles"), { recursive: true });
    await writeFile(path.join(sharedHome, ".credentials.yaml"), "", { mode: 0o600 });

    const prepared = await prepareDeepSeekHarnessHome({ sharedHome, stateDir: path.join(root, "bot") });

    const privateProfile = path.join(prepared.home, "profiles", "web");
    expect(await readdir(privateProfile)).toEqual([]);
    expect(await readdir(path.join(sharedHome, "profiles"))).toEqual([]);

    // What dsh then initializes there survives the next start, without a report.
    await writeFile(path.join(privateProfile, "package.json"), '{"name":"dsh-profile-web","private":true}\n');
    await writeFile(path.join(privateProfile, "cordis.patch.yml"), "[]\n");
    const diagnostics: string[] = [];
    await prepareDeepSeekHarnessHome({ sharedHome, stateDir: path.join(root, "bot"), onDiagnostic: (message) => diagnostics.push(message) });
    expect((await readdir(privateProfile)).sort()).toEqual(["cordis.patch.yml", "package.json"]);
    expect(diagnostics).toEqual([]);

    // Once the user's profile exists, the Bot adopts it.
    await mkdir(path.join(sharedHome, "profiles", "web"));
    await writeFile(path.join(sharedHome, "profiles", "web", "cordis.patch.yml"), SHARED_PATCH);
    await prepareDeepSeekHarnessHome({ sharedHome, stateDir: path.join(root, "bot") });
    expect(await readFile(path.join(privateProfile, "cordis.patch.yml"), "utf8")).toBe(SHARED_PATCH);
  });

  it("still requires the shared profiles directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "deepseek-harness-profile-missing-"));
    roots.push(root);
    const sharedHome = path.join(root, "shared");
    await mkdir(sharedHome, { recursive: true });
    await writeFile(path.join(sharedHome, ".credentials.yaml"), "", { mode: 0o600 });

    await expect(prepareDeepSeekHarnessHome({ sharedHome, stateDir: path.join(root, "bot") }))
      .rejects.toThrow(`DeepSeek Harness shared dir is missing: ${path.join(sharedHome, "profiles")}`);
  });

  it("replaces a private link instead of writing through it", async () => {
    const f = await fixture();
    await prepareDeepSeekHarnessHome({ sharedHome: f.sharedHome, stateDir: f.stateDir });
    const privatePackage = path.join(f.privateProfile, "package.json");
    await rm(privatePackage);
    await symlink(path.join(f.sharedProfile, "package.json"), privatePackage, "file");
    // The same inside a package, where the shared file has since changed.
    const privateIndex = path.join(f.privateProfile, "node_modules", "plugin-a", "index.js");
    const sharedIndex = path.join(f.sharedProfile, "node_modules", "plugin-a", "index.js");
    await rm(privateIndex);
    await symlink(sharedIndex, privateIndex, "file");
    await writeFile(sharedIndex, "export const changed = true;\n");
    await chmod(path.join(f.sharedProfile, "package.json"), 0o644);
    const before = await tree(f.sharedHome);

    await prepareDeepSeekHarnessHome({ sharedHome: f.sharedHome, stateDir: f.stateDir });

    expect((await lstat(privatePackage)).isSymbolicLink()).toBe(false);
    expect(await readFile(privatePackage, "utf8")).toBe('{"name":"dsh-profile-web"}\n');
    expect((await lstat(privateIndex)).isSymbolicLink()).toBe(false);
    expect(await readFile(privateIndex, "utf8")).toBe("export const changed = true;\n");
    expect(await tree(f.sharedHome)).toEqual(before);
    expect((await stat(path.join(f.sharedProfile, "package.json"))).mode & 0o777).toBe(0o644);
  });

  it("keeps a copied file link whole when its refresh fails (synthetic platform)", async () => {
    const f = await fixture();
    const privateHome = path.join(f.stateDir, "dsh-home");
    await mkdir(privateHome, { recursive: true });
    const tool = path.join(f.privateProfile, "node_modules", ".bin", "tool");
    fsCalls.symlinkEpermForFiles = true;
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    try {
      await prepareDeepSeekHarnessPrivateProfile({ sharedHome: f.sharedHome, privateHome });
      expect(await readFile(tool, "utf8")).toBe("#!/usr/bin/env node\n");
      fsCalls.copyFailOnceFor.add(path.join(f.sharedProfile, "node_modules", ".bin", "tool"));
      await expect(prepareDeepSeekHarnessPrivateProfile({ sharedHome: f.sharedHome, privateHome })).rejects.toThrow(/EIO/);
    } finally {
      Object.defineProperty(process, "platform", platform);
    }

    // The copy that stood in for the link is still whole.
    expect(await readFile(tool, "utf8")).toBe("#!/usr/bin/env node\n");
    // A later start with file links available can atomically replace that copy.
    fsCalls.symlinkEpermForFiles = false;
    expect(await prepare(f)).toEqual([]);
    expect((await lstat(tool)).isSymbolicLink()).toBe(true);
    expect(await readFile(tool, "utf8")).toBe("#!/usr/bin/env node\n");
  });

  it("does not copy again what arrived before a start failed", async () => {
    const f = await fixture();
    const retainedSource = path.join(f.sharedProfile, "node_modules", "@scope", "plugin-b", "index.js");
    let arrived!: () => void;
    const copied = new Promise<void>(resolve => { arrived = resolve; });
    fsCalls.beforeCopyFailure = () => copied;
    fsCalls.afterCopy = source => { if (source === retainedSource) arrived(); };
    fsCalls.copyFailOnceFor.add(path.join(f.sharedProfile, "node_modules", "plugin-a", "index.js"));
    await expect(prepareDeepSeekHarnessHome({ sharedHome: f.sharedHome, stateDir: f.stateDir })).rejects.toThrow(/EIO/);
    const retained = path.join(f.privateProfile, "node_modules", "@scope", "plugin-b", "index.js");
    const before = await lstat(retained);
    expect(before.isFile()).toBe(true);

    expect(await prepare(f)).toEqual([]);

    const after = await lstat(retained);
    expect([after.ino, after.mtimeMs]).toEqual([before.ino, before.mtimeMs]);
    expect(await readFile(path.join(f.privateProfile, "node_modules", "plugin-a", "index.js"), "utf8")).toBe("export {};\n");
  });

  it.each(["file", "link"])("mirrors a %s path it had to keep as a directory once that directory is empty", async kind => {
    const f = await fixture();
    await prepare(f);
    const sharedDist = path.join(f.sharedProfile, "node_modules", "plugin-a", "dist");
    const privateDist = path.join(f.privateProfile, "node_modules", "plugin-a", "dist");
    await writeFile(path.join(privateDist, "runtime-cache.bin"), "private\n");
    await rm(path.join(f.sharedProfile, "node_modules", ".bin", "tool"));
    await rm(sharedDist, { recursive: true });
    if (kind === "file") await writeFile(sharedDist, "export const bundled = true;\n");
    else {
      const linked = path.join(f.root, "replacement.js");
      await writeFile(linked, "export const bundled = true;\n");
      await symlink(linked, sharedDist, "file");
    }

    const kept = await prepare(f);
    expect(kept.filter((line) => line.endsWith(`: ${privateDist}`))).toHaveLength(1);
    expect(await readFile(path.join(privateDist, "runtime-cache.bin"), "utf8")).toBe("private\n");

    // Once the private file is gone, the shared file takes the path.
    await rm(path.join(privateDist, "runtime-cache.bin"));
    expect(await prepare(f)).toEqual([]);
    expect(await readFile(privateDist, "utf8")).toBe("export const bundled = true;\n");
  });
});
