import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

/** The DSH profile every Bot boots (`dsh web`, `dsh --profile web --dump-config`). */
export const DEEPSEEK_HARNESS_PROFILE = "web";

export interface PrepareDeepSeekHarnessPrivateProfileOptions {
  sharedHome: string;
  privateHome: string;
  onDiagnostic?: (message: string) => void;
}

export interface PreparedDeepSeekHarnessPrivateProfile {
  profileDir: string;
  patchPath: string;
}

// dsh rewrites the profile root on every boot and keeps its write locks and
// atomic-write temp files beside their targets. They belong to the process
// using this directory, so they are neither mirrored nor removed.
const DSH_OWNED_ENTRY = /^cordis\.yml$|\.lock(?:\.takeover-[0-9a-f]+)?$|\.tmp$/;
// The dsh 0.1.5 link backend's projection, which current dsh deletes on start.
const LEGACY_LINK_PROJECTION_DIR = ".dsh-module-fallback";
const PACKAGE_DIRECTORY = "node_modules";
/** Lists what this module created in the private profile. Nothing else is ever removed, except bare links. */
const MIRROR_MANIFEST = ".open-super-agent-profile-mirror.json";
/** Where a file is written in full before it replaces its target. */
const MIRROR_STAGING = ".open-super-agent-profile-mirror.tmp";
/** Files copied or checked at once. */
const MIRROR_CONCURRENCY = 8;

type MirrorRecord =
  | { kind: "dir" }
  // A file below the profile root keeps the source's size and time and its own
  // time, so an unchanged package is not copied again on the next start.
  | { kind: "file"; size?: number; mtimeMs?: number; privateMtimeMs?: number }
  | { kind: "link" };

interface MirrorManifest {
  version: 1;
  entries: Record<string, MirrorRecord>;
}

type PlanItem =
  | { kind: "dir"; rel: string }
  | { kind: "file"; rel: string; source: string; size: number; mtimeMs: number; mode: number; top: boolean }
  | { kind: "link"; rel: string; source: string; target: string; directory: boolean };

/** A mirrored shared directory, by real path, and the private directory that stands for it. */
interface MirrorRoot {
  real: string;
  private: string;
}

/**
 * Give one Bot a private copy of the shared DSH profile.
 *
 * dsh saves every model and reasoning choice (`session/selectModel` stores the
 * default for new sessions in the background) and every settings edit into
 * `$DSH_HOME/profiles/<profile>/cordis.patch.yml`. A linked `profiles`
 * directory let one Bot rewrite the default of every other Bot and of the
 * user's own `dsh web`, even when the value equalled a home-patch pin.
 *
 * The private profile is a real copy, refreshed one-way from the shared one on
 * every Host start: files are copied and directories recreated, so every
 * plugin module really lies below the Bot's active profile. dsh routes a
 * module by its real path. A plugin reached through a link into the shared
 * home is outside the active profile and only receives the runtime packages it
 * declares as peers; a copied one resolves exactly as it does for the user's
 * own dsh, declared or not. A link inside the shared profile is recreated
 * inside the private one, and a link that leaves it (a plugin the user linked
 * from a development directory) stays a link, as it is for the user's dsh.
 *
 * dsh-owned boot, lock and temp files stay private. Nothing under the shared
 * home is written. The manifest records what this function created; later
 * starts remove only those entries and bare links, never recursively, and keep
 * anything else they find. Every path is reached through real private
 * directories checked one by one: where a link has taken the place of one,
 * only that link is removed and nothing beyond it is read, written or
 * deleted. A file is replaced by renaming a complete copy over it. An old
 * `profiles` link or junction is migrated by removing only the link itself.
 */
export async function prepareDeepSeekHarnessPrivateProfile(
  options: PrepareDeepSeekHarnessPrivateProfileOptions,
): Promise<PreparedDeepSeekHarnessPrivateProfile> {
  // A Host that is closed and reconnected at once can start a second
  // preparation while the first still runs; they take turns.
  const key = path.resolve(options.privateHome);
  const earlier = preparing.get(key);
  const current = (earlier ? earlier.then(() => {}, () => {}) : Promise.resolve()).then(() => mirrorSharedProfile(options));
  preparing.set(key, current);
  try {
    return await current;
  } finally {
    if (preparing.get(key) === current) preparing.delete(key);
  }
}

/** Preparations in progress, by private home. */
const preparing = new Map<string, Promise<PreparedDeepSeekHarnessPrivateProfile>>();

async function mirrorSharedProfile(
  options: PrepareDeepSeekHarnessPrivateProfileOptions,
): Promise<PreparedDeepSeekHarnessPrivateProfile> {
  const sharedProfiles = path.join(path.resolve(options.sharedHome), "profiles");
  await stat(sharedProfiles).then((info) => {
    if (!info.isDirectory()) throw new Error(`DeepSeek Harness shared dir is missing: ${sharedProfiles}`);
  }, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new Error(`DeepSeek Harness shared dir is missing: ${sharedProfiles}`);
    throw error;
  });

  const privateProfiles = path.join(path.resolve(options.privateHome), "profiles");
  const profileDir = path.join(privateProfiles, DEEPSEEK_HARNESS_PROFILE);
  await ensurePrivateDirectory(privateProfiles);
  await ensurePrivateDirectory(profileDir);

  const reported = new Set<string>();
  const diagnose = (message: string, target: string): void => {
    if (reported.has(target)) return;
    reported.add(target);
    options.onDiagnostic?.(`${message}: ${target}`);
  };
  const tree = new PrivateProfileTree(profileDir);
  await tree.clearStaging();

  const sharedProfile = path.join(sharedProfiles, DEEPSEEK_HARNESS_PROFILE);
  // A shared home without this profile leaves the private one for dsh to
  // initialize; the next start adopts the shared profile once it exists.
  const sharedProfileExists = (await stat(sharedProfile).catch(() => undefined))?.isDirectory() === true;
  const plan = sharedProfileExists ? await planProfileMirror(sharedProfile, profileDir) : [];
  const planned = new Set(plan.map((item) => item.rel));
  const manifestPath = path.join(profileDir, MIRROR_MANIFEST);
  const previous = await readMirrorManifest(manifestPath);

  // Record the entries about to be created before creating them, so a start
  // that fails halfway still leaves them known to the next one.
  const intent: MirrorManifest = { version: 1, entries: { ...previous.entries } };
  for (const item of plan) {
    if (!intent.entries[item.rel]) intent.entries[item.rel] = { kind: item.kind };
  }
  await writeMirrorManifest(manifestPath, intent);

  // Entries an earlier start created and the shared profile no longer has,
  // children before their directories. They go first, so a path that turned
  // from a directory into a file is free again.
  const stale = Object.keys(previous.entries).filter((rel) => !planned.has(rel))
    .sort((left, right) => right.split("/").length - left.split("/").length || right.localeCompare(left));
  for (const rel of stale) {
    const target = tree.path(rel);
    // Below a link, or below a directory that is gone, nothing is this Bot's.
    if (!(await tree.holds(path.dirname(target)))) continue;
    await removeOwnedEntry(target, previous.entries[rel]!, diagnose);
    tree.forget(target);
  }
  tree.forgetAll();

  // Directories first, in order, so every file and link below finds its parent;
  // those then go a few at a time, which is what a large plugin tree needs.
  const next: MirrorManifest = { version: 1, entries: {} };
  for (const item of plan) {
    if (item.kind !== "dir") continue;
    const target = await tree.pathInHeldDirectory(item.rel);
    await ensureMirrorDirectory(target);
    tree.hold(target);
    next.entries[item.rel] = { kind: "dir" };
  }
  try {
    await forEachLimited(plan.filter((item) => item.kind !== "dir"), MIRROR_CONCURRENCY, async (item) => {
      const target = await tree.pathInHeldDirectory(item.rel);
      const record = item.kind === "file"
        ? await mirrorFile(tree, item, target, previous.entries[item.rel], diagnose)
        : item.kind === "link" ? await mirrorLink(tree, item, target, previous.entries[item.rel], diagnose) : undefined;
      if (record) next.entries[item.rel] = record;
    });
  } catch (error) {
    // Record the files that did arrive, so the next start does not copy them again.
    await writeMirrorManifest(manifestPath, { version: 1, entries: { ...intent.entries, ...next.entries } }).catch(() => {});
    throw error;
  }

  // Entries no start recorded: a link is removed (it holds no data and may be
  // left from the earlier link layout); anything else is kept and reported.
  for (const name of await readDirectoryNames(profileDir)) {
    if (planned.has(name) || isMirrorOwnName(name) || name === LEGACY_LINK_PROJECTION_DIR || DSH_OWNED_ENTRY.test(name)) continue;
    const target = path.join(profileDir, name);
    const info = await lstatOptional(target);
    if (info?.isSymbolicLink()) await removeLink(target);
    else if (info && sharedProfileExists) diagnose("DeepSeek Harness kept an unexpected private profile entry", target);
  }
  if (planned.has(PACKAGE_DIRECTORY)) {
    await sweepUnrecordedPackages(path.join(profileDir, PACKAGE_DIRECTORY), PACKAGE_DIRECTORY, planned, diagnose);
  }

  await writeMirrorManifest(manifestPath, next);
  await tree.clearStaging();
  return { profileDir, patchPath: path.join(profileDir, "cordis.patch.yml") };
}

function isMirrorOwnName(name: string): boolean {
  return name === MIRROR_MANIFEST || name === MIRROR_STAGING;
}

/**
 * The Bot's private profile directory. A path counts as inside it only when
 * every directory on the way is a real one, so no change can reach through a
 * link into the shared home or anywhere else.
 */
class PrivateProfileTree {
  private readonly held = new Map<string, boolean>();
  private staging: Promise<string> | undefined;
  private staged = 0;

  constructor(private readonly root: string) {}

  path(rel: string): string {
    return path.join(this.root, ...rel.split("/"));
  }

  /** Whether `directory` is the profile itself or a real directory below it reached through real directories only. */
  async holds(directory: string): Promise<boolean> {
    if (directory === this.root) return true;
    if (!directory.startsWith(this.root + path.sep)) return false;
    const known = this.held.get(directory);
    if (known !== undefined) return known;
    // The parent is checked first, so this lstat reads the entry itself.
    const held = await this.holds(path.dirname(directory)) && (await lstatOptional(directory))?.isDirectory() === true;
    this.held.set(directory, held);
    return held;
  }

  /** The private path of a planned entry, refused unless its directory is held. */
  async pathInHeldDirectory(rel: string): Promise<string> {
    const target = this.path(rel);
    if (!(await this.holds(path.dirname(target)))) {
      throw new Error(`DeepSeek Harness private profile path is not inside a private directory: ${target}`);
    }
    return target;
  }

  /** A directory this start has just made sure is a real one. */
  hold(directory: string): void {
    this.held.set(directory, true);
  }

  forget(directory: string): void {
    this.held.delete(directory);
  }

  forgetAll(): void {
    this.held.clear();
  }

  /** A fresh private path to write a whole file to before renaming it over its target. */
  async stage(): Promise<string> {
    this.staging ??= (async () => {
      const directory = path.join(this.root, MIRROR_STAGING);
      await ensureMirrorDirectory(directory);
      return directory;
    })();
    const directory = await this.staging;
    return path.join(directory, `${this.staged++}.tmp`);
  }

  /** Remove the staging directory and what an interrupted start left in it. */
  async clearStaging(): Promise<void> {
    this.staging = undefined;
    const directory = path.join(this.root, MIRROR_STAGING);
    const info = await lstatOptional(directory);
    if (!info) return;
    if (info.isSymbolicLink()) {
      await removeLink(directory);
      return;
    }
    if (!info.isDirectory()) {
      await unlink(directory);
      return;
    }
    for (const name of await readDirectoryNames(directory)) {
      const entry = path.join(directory, name);
      const entryInfo = await lstatOptional(entry);
      if (entryInfo?.isSymbolicLink()) await removeLink(entry);
      else if (entryInfo?.isFile()) await unlink(entry);
    }
    await rmdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOTEMPTY" && error.code !== "EEXIST" && error.code !== "ENOENT") throw error;
    });
  }
}

/** Everything the shared profile holds, parents before children, without touching the private profile. */
async function planProfileMirror(sharedProfile: string, profileDir: string): Promise<PlanItem[]> {
  const plan: PlanItem[] = [];
  const roots: MirrorRoot[] = [{ real: await realpath(sharedProfile), private: profileDir }];
  for (const name of await readDirectoryNames(sharedProfile)) {
    if (DSH_OWNED_ENTRY.test(name) || name === LEGACY_LINK_PROJECTION_DIR || isMirrorOwnName(name)) continue;
    const source = path.join(sharedProfile, name);
    const info = await stat(source).catch(() => undefined);
    if (info?.isFile()) {
      // A linked profile file is read through its link; the copy is private.
      plan.push({ kind: "file", rel: name, source, size: info.size, mtimeMs: info.mtimeMs, mode: 0o600, top: true });
      continue;
    }
    if (!info?.isDirectory()) continue;
    if ((await lstat(source)).isSymbolicLink()) {
      if (name !== PACKAGE_DIRECTORY) {
        await planLink(source, name, roots, plan);
        continue;
      }
      // A relocated package directory is still this profile's own.
      roots.push({ real: await realpath(source), private: path.join(profileDir, name) });
    }
    plan.push({ kind: "dir", rel: name });
    await planDirectory(source, name, roots, plan);
  }
  return plan;
}

async function planDirectory(sourceDir: string, relDir: string, roots: MirrorRoot[], plan: PlanItem[]): Promise<void> {
  for (const name of await readDirectoryNames(sourceDir)) {
    const source = path.join(sourceDir, name);
    const rel = `${relDir}/${name}`;
    // lstat, not the directory entry type: Windows lists every reparse point as a link.
    const info = await lstatOptional(source);
    if (!info) continue;
    if (info.isSymbolicLink()) {
      await planLink(source, rel, roots, plan);
    } else if (info.isDirectory()) {
      plan.push({ kind: "dir", rel });
      await planDirectory(source, rel, roots, plan);
    } else if (info.isFile()) {
      plan.push({
        kind: "file", rel, source, size: info.size, mtimeMs: info.mtimeMs,
        mode: (info.mode & 0o700) | 0o600, top: false,
      });
    }
  }
}

/**
 * A link that stays inside a mirrored directory points to the private copy of
 * its target; one that leaves it keeps pointing at the shared entry. A dangling
 * link is skipped: Node cannot load through it either.
 */
async function planLink(source: string, rel: string, roots: MirrorRoot[], plan: PlanItem[]): Promise<void> {
  const real = await realpath(source).catch(() => undefined);
  const info = real === undefined ? undefined : await stat(source).catch(() => undefined);
  if (real === undefined || !info || (!info.isDirectory() && !info.isFile())) return;
  const root = roots.find((candidate) => real === candidate.real || real.startsWith(candidate.real + path.sep));
  const target = root ? path.join(root.private, path.relative(root.real, real)) : source;
  plan.push({ kind: "link", rel, source, target, directory: info.isDirectory() });
}

/** Run `task` over `items`, at most `limit` at a time. The first failure stops new work and is thrown once the rest settle. */
async function forEachLimited<T>(items: readonly T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  let failure: { error: unknown } | undefined;
  const worker = async (): Promise<void> => {
    while (!failure && index < items.length) {
      const item = items[index++]!;
      try {
        await task(item);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure) throw failure.error;
}

async function ensurePrivateDirectory(target: string): Promise<void> {
  await ensureMirrorDirectory(target);
  await chmod(target, 0o700).catch(() => {});
}

async function ensureMirrorDirectory(target: string): Promise<void> {
  const info = await lstatOptional(target);
  if (info?.isDirectory()) return;
  if (info?.isSymbolicLink()) {
    // An existing Bot's `profiles` link (a junction on Windows) or an earlier
    // package link: remove the link only, never anything it points to.
    await removeLink(target);
  } else if (info) {
    await unlink(target);
  }
  try {
    await mkdir(target, { mode: 0o700 });
  } catch (error) {
    // Another start of the same Bot may have created it meanwhile.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !(await lstat(target)).isDirectory()) throw error;
  }
  await chmod(target, 0o700).catch(() => {});
}

async function mirrorFile(
  tree: PrivateProfileTree,
  item: Extract<PlanItem, { kind: "file" }>,
  target: string,
  previous: MirrorRecord | undefined,
  diagnose: (message: string, target: string) => void,
): Promise<MirrorRecord | undefined> {
  const info = await lstatWithoutOwnedDirectory(target, previous);
  if (info?.isDirectory()) {
    diagnose("DeepSeek Harness kept an unexpected private directory instead of copying a shared file", target);
    // Still the directory an earlier start created: keep its record, so it goes once it is empty.
    return previous?.kind === "dir" ? previous : undefined;
  }
  if (info?.isFile()) {
    if (item.top) {
      // dsh rewrites these few small files, so compare what they contain.
      if ((await readFile(item.source)).equals(await readFile(target))) {
        await chmod(target, item.mode).catch(() => {});
        return { kind: "file" };
      }
    } else if (
      previous?.kind === "file" && previous.size === item.size && previous.mtimeMs === item.mtimeMs
      && info.size === item.size && previous.privateMtimeMs === info.mtimeMs
    ) {
      return previous;
    }
  } else if (info?.isSymbolicLink()) {
    // A link is replaced, never written through.
    await removeLink(target);
  } else if (info) {
    await unlink(target);
  }
  await replaceWithCopy(tree, item.source, target, item.mode);
  if (item.top) return { kind: "file" };
  return { kind: "file", size: item.size, mtimeMs: item.mtimeMs, privateMtimeMs: (await lstat(target)).mtimeMs };
}

async function mirrorLink(
  tree: PrivateProfileTree,
  item: Extract<PlanItem, { kind: "link" }>,
  target: string,
  previous: MirrorRecord | undefined,
  diagnose: (message: string, target: string) => void,
): Promise<MirrorRecord | undefined> {
  const info = await lstatWithoutOwnedDirectory(target, previous);
  if (info?.isSymbolicLink()) {
    if (path.resolve(path.dirname(target), await readlink(target)) === item.target) return { kind: "link" };
    await removeLink(target);
  } else if (info?.isDirectory()) {
    diagnose("DeepSeek Harness kept an unexpected private directory instead of linking the shared one", target);
    return previous?.kind === "dir" ? previous : undefined;
  }
  // A whole file where a file link belongs stays until its replacement is complete.
  const replacesFile = info?.isFile() === true && !item.directory;
  if (info && !info.isSymbolicLink() && !replacesFile) {
    await unlink(target);
  }
  try {
    if (replacesFile) await replaceWithLink(tree, item.target, target);
    else await symlink(item.target, target, item.directory ? (process.platform === "win32" ? "junction" : "dir") : "file");
    return { kind: "link" };
  } catch (error) {
    // Windows needs a privilege for file links; a private copy loads the same.
    if (item.directory || process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    await replaceWithCopy(tree, item.source, target, 0o600);
    return { kind: "file" };
  }
}

/**
 * Copy `source` to a private staging file, then rename it over `target`. The
 * target keeps what it held until the copy is complete, so a failed or
 * interrupted start leaves the old file, never a missing or partial one.
 */
async function replaceWithCopy(tree: PrivateProfileTree, source: string, target: string, mode: number): Promise<void> {
  const staged = await tree.stage();
  try {
    await copyFile(source, staged, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    await chmod(staged, mode).catch(() => {});
    try {
      await rename(staged, target);
    } catch (error) {
      // Windows does not rename over a read-only file.
      if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      if (!(await lstatOptional(target))?.isFile()) throw error;
      await chmod(target, 0o600);
      await rename(staged, target);
    }
  } finally {
    await rm(staged, { force: true }).catch(() => {});
  }
}

/** Create a file link in staging, then rename it over the file at `target`. */
async function replaceWithLink(tree: PrivateProfileTree, linkTarget: string, target: string): Promise<void> {
  const staged = await tree.stage();
  try {
    await symlink(linkTarget, staged, "file");
    await rename(staged, target);
  } finally {
    await rm(staged, { force: true }).catch(() => {});
  }
}

/** Remove one entry an earlier start recorded; a directory only once it is empty. */
async function removeOwnedEntry(
  target: string,
  record: MirrorRecord,
  diagnose: (message: string, target: string) => void,
): Promise<void> {
  const info = await lstatOptional(target);
  if (!info) return;
  if (info.isSymbolicLink()) {
    await removeLink(target);
  } else if (info.isDirectory()) {
    if (record.kind === "dir") await removeEmptyDirectory(target, diagnose);
    else diagnose("DeepSeek Harness kept an unexpected private profile entry", target);
  } else if (record.kind === "dir") {
    diagnose("DeepSeek Harness kept an unexpected private profile entry", target);
  } else {
    await unlink(target);
  }
}

/** Package entries and `@scope` children no start recorded, such as the links of the earlier layout. */
async function sweepUnrecordedPackages(
  directory: string,
  relDir: string,
  planned: ReadonlySet<string>,
  diagnose: (message: string, target: string) => void,
): Promise<void> {
  for (const name of await readDirectoryNames(directory)) {
    const rel = `${relDir}/${name}`;
    const target = path.join(directory, name);
    const info = await lstatOptional(target);
    if (!info) continue;
    if (info.isSymbolicLink()) {
      if (!planned.has(rel)) await removeLink(target);
    } else if (info.isDirectory() && name.startsWith("@") && relDir === PACKAGE_DIRECTORY) {
      await sweepUnrecordedPackages(target, rel, planned, diagnose);
      if (!planned.has(rel)) await removeEmptyDirectory(target, diagnose);
    } else if (!planned.has(rel)) {
      diagnose("DeepSeek Harness kept an unexpected private package entry", target);
    }
  }
}

async function removeEmptyDirectory(target: string, diagnose: (message: string, target: string) => void): Promise<void> {
  await rmdir(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOTEMPTY" && error.code !== "EEXIST") throw error;
    diagnose("DeepSeek Harness kept a non-empty private directory", target);
  });
}

/** Remove a symlink or Windows junction without touching its target. */
async function removeLink(target: string): Promise<void> {
  try {
    await unlink(target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform !== "win32" || (code !== "EPERM" && code !== "EISDIR")) throw error;
    // A directory junction is removed with rmdir, which never recurses.
    await rmdir(target);
  }
}

/**
 * The entry at a path that must now hold a file or link. A directory an earlier
 * start created there has already lost its recorded children; once empty it is
 * removed, and one that still holds something is returned and kept.
 */
async function lstatWithoutOwnedDirectory(target: string, previous: MirrorRecord | undefined): Promise<Stats | undefined> {
  const info = await lstatOptional(target);
  if (!info?.isDirectory() || previous?.kind !== "dir") return info;
  try {
    await rmdir(target);
    return undefined;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
    return info;
  }
}

async function lstatOptional(target: string): Promise<Stats | undefined> {
  return await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
    throw error;
  });
}

async function readDirectoryNames(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory)).sort();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw error;
  }
}

/** A missing or unreadable manifest records nothing, so nothing is removed on its word. */
async function readMirrorManifest(manifestPath: string): Promise<MirrorManifest> {
  const manifest: MirrorManifest = { version: 1, entries: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
  } catch {
    return manifest;
  }
  const entries = isRecord(parsed) && parsed.version === 1 && isRecord(parsed.entries) ? parsed.entries : {};
  for (const [rel, value] of Object.entries(entries)) {
    if (!isMirrorPath(rel) || !isRecord(value)) continue;
    if (value.kind === "dir" || value.kind === "link") {
      manifest.entries[rel] = { kind: value.kind };
    } else if (value.kind === "file") {
      manifest.entries[rel] = {
        kind: "file",
        ...(typeof value.size === "number" ? { size: value.size } : {}),
        ...(typeof value.mtimeMs === "number" ? { mtimeMs: value.mtimeMs } : {}),
        ...(typeof value.privateMtimeMs === "number" ? { privateMtimeMs: value.privateMtimeMs } : {}),
      };
    }
  }
  return manifest;
}

/** Only a plain path below the private profile may be named by the manifest. */
function isMirrorPath(rel: string): boolean {
  if (isMirrorOwnName(rel.split("/")[0]!)) return false;
  return rel.split("/").every((segment) => (
    segment !== "" && segment !== "." && segment !== ".." && !/[\\\0:]/.test(segment)
  ));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Written only when it changed, so an unchanged profile is left byte for byte as it was. */
async function writeMirrorManifest(manifestPath: string, manifest: MirrorManifest): Promise<void> {
  const sorted = Object.fromEntries(Object.entries(manifest.entries).sort(([left], [right]) => left.localeCompare(right)));
  const contents = Buffer.from(`${JSON.stringify({ version: 1, entries: sorted })}\n`);
  const info = await lstatOptional(manifestPath);
  // A profile that never had anything mirrored gets no manifest either.
  if (!info && Object.keys(sorted).length === 0) return;
  if (info?.isFile() && contents.equals(await readFile(manifestPath))) return;
  if (info?.isSymbolicLink()) await removeLink(manifestPath);
  else if (info?.isDirectory()) throw new Error(`DeepSeek Harness profile manifest path is a directory: ${manifestPath}`);
  await writePrivateFileAtomically(manifestPath, contents);
}

async function writePrivateFileAtomically(filePath: string, contents: Buffer): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, contents, { mode: 0o600 });
    await chmod(tempPath, 0o600).catch(() => {});
    await rename(tempPath, filePath);
  } finally {
    await rm(tempPath, { force: true }).catch(() => {});
  }
}
