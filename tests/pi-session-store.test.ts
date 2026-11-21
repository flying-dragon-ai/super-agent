import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PI_TRUST_GATED_PATHS, PiSessionStore, expandPiPath, hasPiTrustGatedFiles, isSafePiSessionId, piAgentDir, piBotDefaultFingerprint,
  piNativeSessionDir, piNativeSessionDirFor,
} from "../src/codex/pi-session-store.js";

const readFault = vi.hoisted(() => ({ file: "", code: "", reads: 0 }));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: (...args: Parameters<typeof actual.readFile>) => {
    if (args[0] === readFault.file && readFault.code) {
      readFault.reads++;
      return Promise.reject(Object.assign(new Error("Synthetic read failure"), { code: readFault.code }));
    }
    return actual.readFile(...args);
  } };
});

const roots: string[] = [];
afterEach(async () => {
  readFault.file = ""; readFault.code = ""; readFault.reads = 0;
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function scratch(): Promise<{ root: string; stateDir: string; agentDir: string; cwd: string; store: PiSessionStore; make(env?: NodeJS.ProcessEnv): PiSessionStore }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-store-"));
  roots.push(root);
  const stateDir = path.join(root, "state"), agentDir = path.join(root, "agent"), cwd = path.join(root, "workspace");
  await mkdir(cwd, { recursive: true });
  const make = (env: NodeJS.ProcessEnv = { PI_CODING_AGENT_DIR: agentDir }) => new PiSessionStore({ stateDir, childEnv: env, homeDir: path.join(root, "account") });
  return { root, stateDir, agentDir, cwd, store: make(), make };
}

const header = (id: string, cwd: string, extra: Record<string, unknown> = {}) => JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-02T03:04:05.000Z", cwd, ...extra });
const userEntry = (text: string, n = 1) => JSON.stringify({ type: "message", id: `m${n}`, parentId: null, timestamp: "2026-01-02T03:04:06.000Z", message: { role: "user", content: text } });
const nameEntry = (name?: string, n = 1) => JSON.stringify({ type: "session_info", id: `s${n}`, parentId: null, timestamp: "2026-01-02T03:04:07.000Z", ...(name === undefined ? {} : { name }) });

async function writeSession(dir: string, id: string, cwd: string, lines: string[] = [], options: { fileId?: string; mtime?: number; headerExtra?: Record<string, unknown> } = {}): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `2026-01-02T03-04-05-000Z_${options.fileId ?? id}.jsonl`);
  await writeFile(file, `${[header(id, cwd, options.headerExtra), ...lines].join("\n")}\n`);
  if (options.mtime !== undefined) await utimes(file, options.mtime, options.mtime);
  return file;
}

describe("Pi session locations", () => {
  it("encodes a workspace the way Pi 1.5.2 names its session directory", () => {
    // session-manager.ts:590-595: strip one leading separator, then turn every / \ : into "-".
    const reference = (cwd: string) => `--${path.resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
    for (const cwd of ["/synthetic/work/my project", "/synthetic/C:\\repo\\x", "/synthetic/a:b/c", "/", "/synthetic/trailing/"]) {
      expect(piNativeSessionDir(cwd, "/synthetic/agent")).toBe(path.join(path.resolve("/synthetic/agent"), "sessions", reference(cwd)));
    }
    if (process.platform !== "win32") {
      expect(piNativeSessionDir("/synthetic/work/my project", "/synthetic/agent")).toBe("/synthetic/agent/sessions/--synthetic-work-my project--");
      expect(piNativeSessionDir("/synthetic/C:\\repo\\x", "/synthetic/agent")).toBe("/synthetic/agent/sessions/--synthetic-C--repo-x--");
    }
  });

  it("resolves a relative workspace and agent directory before encoding", () => {
    const relative = piNativeSessionDir("some/dir", "agent-dir");
    expect(path.isAbsolute(relative)).toBe(true);
    expect(relative).toBe(piNativeSessionDir(path.resolve("some/dir"), path.resolve("agent-dir")));
  });

  it("uses the native agent directory override, else the account's .pi/agent", () => {
    expect(piAgentDir({ PI_CODING_AGENT_DIR: "  /synthetic/custom-agent  " }, "/synthetic/account")).toBe(path.resolve("/synthetic/custom-agent"));
    expect(piAgentDir({}, "/synthetic/account")).toBe(path.join("/synthetic/account", ".pi", "agent"));
    expect(piAgentDir({ PI_CODING_AGENT_DIR: "   " }, "/synthetic/account")).toBe(path.join("/synthetic/account", ".pi", "agent"));
    expect(piAgentDir({})).toBe(path.join(os.homedir(), ".pi", "agent"));
  });

  it("keeps Bot sessions under <stateDir>/pi/sessions and creates the directory privately", async () => {
    const { store, stateDir } = await scratch();
    expect(store.rootDir).toBe(path.join(stateDir, "pi"));
    expect(store.sessionDir).toBe(path.join(stateDir, "pi", "sessions"));
    await store.ensureDirs();
    await store.ensureDirs();
    const info = await stat(store.sessionDir);
    expect(info.isDirectory()).toBe(true);
    if (process.platform !== "win32") expect(info.mode & 0o777).toBe(0o700);
  });

  it("follows Pi's session directory relocation variable", async () => {
    const { make, cwd, agentDir, root } = await scratch();
    expect(await make().nativeSessionDir(cwd)).toBe(piNativeSessionDir(cwd, agentDir));
    const flat = path.join(root, "flat-sessions");
    expect(await make({ PI_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_SESSION_DIR: ` ${flat} ` }).nativeSessionDir(cwd)).toBe(flat);
  });

  it("expands `~` and file URLs as Pi's normalizePath does, and leaves relative paths for the caller's cwd", async () => {
    const home = path.resolve("/synthetic/account");
    expect(expandPiPath("~", home)).toBe(home);
    expect(expandPiPath("~/pi/sessions", home)).toBe(path.join(home, "pi/sessions"));
    expect(expandPiPath("~other/x", home)).toBe("~other/x");
    const target = path.resolve("/synthetic/x");
    expect(expandPiPath(pathToFileURL(target).href, home)).toBe(target);
    expect(expandPiPath("rel/dir", home)).toBe("rel/dir");
    expect(piAgentDir({ PI_CODING_AGENT_DIR: "~/custom-agent" }, home)).toBe(path.join(home, "custom-agent"));
    // Pi runs in the workspace, so a relative variable is read from there, not from the Host's own directory.
    expect(await piNativeSessionDirFor("/synthetic/ws", { PI_CODING_AGENT_DIR: "/synthetic/agent", PI_CODING_AGENT_SESSION_DIR: "~/flat" }, home)).toBe(path.join(home, "flat"));
    expect(await piNativeSessionDirFor("/synthetic/ws", { PI_CODING_AGENT_DIR: "/synthetic/agent", PI_CODING_AGENT_SESSION_DIR: "rel/flat" }, home)).toBe(path.resolve("/synthetic/ws/rel/flat"));
  });

  it("reads a relative PI_CODING_AGENT_DIR from the workspace Pi runs in, never from the Host's own directory", async () => {
    const { root } = await scratch();
    const cwd = path.join(root, "project"), agentDir = path.join(cwd, ".native-agent");
    await mkdir(agentDir, { recursive: true });
    await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ sessionDir: "native-sessions" }));
    const env = { PI_CODING_AGENT_DIR: ".native-agent" };
    expect(piAgentDir(env, "/synthetic/account", cwd)).toBe(agentDir);
    expect(await piNativeSessionDirFor(cwd, env, "/synthetic/account")).toBe(path.join(cwd, "native-sessions"));
    await rm(path.join(agentDir, "settings.json"));
    expect(await piNativeSessionDirFor(cwd, env, "/synthetic/account")).toBe(piNativeSessionDir(cwd, agentDir));
  });

  it("uses `sessionDir` from Pi's settings: the project file over the global one, as Pi merges them", async () => {
    const { make, cwd, agentDir, root } = await scratch();
    const home = path.join(root, "account");
    const settings = async (file: string, value: unknown) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, typeof value === "string" ? value : JSON.stringify(value)); };
    const globalFile = path.join(agentDir, "settings.json"), projectFile = path.join(cwd, ".pi", "settings.json");
    await settings(globalFile, { sessionDir: "~/global-sessions", defaultModel: "x" });
    expect(await make().nativeSessionDir(cwd)).toBe(path.join(home, "global-sessions"));
    await settings(projectFile, { sessionDir: "local-sessions" });
    expect(await make().nativeSessionDir(cwd)).toBe(path.join(cwd, "local-sessions"));
    // Any project value replaces the global one; an empty or null value means Pi's default directory.
    await settings(projectFile, { sessionDir: null });
    expect(await make().nativeSessionDir(cwd)).toBe(piNativeSessionDir(cwd, agentDir));
    await settings(projectFile, { sessionDir: "" });
    expect(await make().nativeSessionDir(cwd)).toBe(piNativeSessionDir(cwd, agentDir));
    // A project file Pi cannot parse counts as empty, so the global value applies again; a BOM is tolerated.
    await settings(projectFile, "{ not json");
    expect(await make().nativeSessionDir(cwd)).toBe(path.join(home, "global-sessions"));
    await settings(projectFile, `\uFEFF${JSON.stringify({ sessionDir: "/synthetic/abs-sessions" })}`);
    expect(await make().nativeSessionDir(cwd)).toBe(path.resolve("/synthetic/abs-sessions"));
    await settings(projectFile, { sessionDir: 42 });
    expect(await make().nativeSessionDir(cwd)).toBe(piNativeSessionDir(cwd, agentDir));
    // The variable still wins over both files.
    expect(await make({ PI_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_SESSION_DIR: "/synthetic/env" }).nativeSessionDir(cwd)).toBe(path.resolve("/synthetic/env"));
  });

  it("validates new default fingerprints while retaining legacy and future record fields", async () => {
    const { stateDir, make } = await scratch();
    await mkdir(path.join(stateDir, "pi"), { recursive: true });
    const good = piBotDefaultFingerprint("provider/model", undefined);
    await writeFile(path.join(stateDir, "pi", "state.json"), JSON.stringify({ version: 1, trust: {}, sessions: {
      legacy: { appliedBotDefault: "legacy", appliedBotModelDefault: 17, appliedBotThinkingDefault: { invalid: true }, futureField: "retained" },
      valid: { appliedBotModelDefault: good, appliedBotThinkingDefault: good },
    } }));
    const store = make();
    expect(await store.record("legacy")).toEqual({ appliedBotDefault: "legacy", futureField: "retained" });
    expect(await store.record("valid")).toEqual({ appliedBotModelDefault: good, appliedBotThinkingDefault: good });
  });

  it("finds Bot and terminal sessions through a linked workspace without admitting another workspace", async () => {
    const { root, cwd, store, agentDir } = await scratch();
    const link = path.join(root, "linked-workspace");
    await symlink(cwd, link, process.platform === "win32" ? "junction" : "dir");
    const nativeDir = piNativeSessionDir(cwd, agentDir);
    await writeSession(nativeDir, "native-real", cwd);
    await writeSession(store.sessionDir, "bot-real", cwd);
    await writeSession(store.sessionDir, "other-project", path.join(root, "other"));
    expect(await store.nativeSessionDir(link)).toBe(process.platform === "win32" ? piNativeSessionDir(link, agentDir) : nativeDir);
    expect((await store.list({ cwd: link })).map(item => item.sessionId).sort()).toEqual(["bot-real", "native-real"]);
    expect((await store.find("native-real", link))?.cwd).toBe(cwd);
  });

  it("discovers Windows terminal sessions from both junction and physical directories, deduplicated", async () => {
    const { root, cwd, store, agentDir } = await scratch();
    const link = path.join(root, "junction-workspace");
    await symlink(cwd, link, process.platform === "win32" ? "junction" : "dir");
    // Only the cwd policy is simulated on POSIX; actual Windows also runs this test with a real junction.
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      const logical = piNativeSessionDir(link, agentDir), physical = piNativeSessionDir(cwd, agentDir);
      await writeSession(logical, "native-junction", link);
      await writeSession(physical, "native-physical", cwd);
      await writeSession(logical, "native-physical", link);
      await writeSession(logical, "another-workspace", path.join(root, "elsewhere"));
      expect(await store.nativeSessionDir(link)).toBe(logical);
      expect((await store.list({ cwd: link })).map(item => item.sessionId).sort()).toEqual(["native-junction", "native-physical"]);
      expect((await store.find("native-junction", link))?.cwd).toBe(link);
      expect((await store.find("native-physical", link))?.sessionId).toBe("native-physical");
    } finally { platform.mockRestore(); }
  });

  it("normalizes Windows shell drive paths only on Windows", () => {
    const paths = [["/c/pi-sessions", "C:\\pi-sessions"], ["/mnt/d/项目 A", "D:\\项目 A"], ["/cygdrive/e/agent/x", "E:\\agent\\x"], ["/F", "F:\\"]];
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      for (const [input, expected] of paths) expect(expandPiPath(input!)).toBe(expected);
      for (const input of ["//server/share", "/ordinary/path", "relative/path", "/c/mixed\\path"]) expect(expandPiPath(input)).toBe(input);
      platform.mockReturnValue("linux");
      for (const [input] of paths) expect(expandPiPath(input!)).toBe(input);
    } finally { platform.mockRestore(); }
  });

  it("lists and finds terminal sessions in a settings-configured directory, only for this workspace", async () => {
    const { make, cwd, agentDir, root } = await scratch();
    const shared = path.join(root, "shared-sessions");
    await mkdir(agentDir, { recursive: true });
    await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ sessionDir: shared }));
    const store = make();
    const mine = await writeSession(shared, "terminal-here", cwd, [nameEntry("Here")], { mtime: 2_000 });
    await writeSession(shared, "terminal-other", path.join(root, "other-workspace"), [], { mtime: 3_000 });
    const listed = await store.list({ cwd });
    expect(listed.map(session => [session.sessionId, session.origin])).toEqual([["terminal-here", "native"]]);
    expect(await store.find("terminal-here", cwd)).toMatchObject({ path: mine, origin: "native", cwd });
    // Found by id, it still carries its own workspace, which the adapter compares before binding.
    expect((await store.find("terminal-other", cwd))?.cwd).toBe(path.join(root, "other-workspace"));
  });
});

describe("isSafePiSessionId", () => {
  it.each(["01a1f81e-07b7-71b7-af7d-b19fe5614a65", "open-super-agent-conv-0001", "a", "A1_b.c-d", "x".repeat(128)])("accepts %s", id => {
    expect(isSafePiSessionId(id)).toBe(true);
  });
  it.each(["", "../x", "a/b", "a\\b", "a..b", "-starts-with-dash", "_underscore-first", ".hidden", "a b", "a\nb", "é", "x".repeat(129), "--session"])("rejects %j", id => {
    expect(isSafePiSessionId(id)).toBe(false);
  });
});

describe("PiSessionStore.readHeader", () => {
  it("reads a valid header and keeps only the known fields", async () => {
    const { store, root } = await scratch();
    const file = await writeSession(root, "abc", "/synthetic/ws", [userEntry("hello")], { headerExtra: { parentSession: "/synthetic/parent.jsonl", surprise: { nested: true } } });
    expect(await store.readHeader(file)).toEqual({ id: "abc", cwd: "/synthetic/ws", version: 3, timestamp: "2026-01-02T03:04:05.000Z", parentSession: "/synthetic/parent.jsonl" });
  });

  it("accepts a header with no trailing newline and a v1 header without version or timestamp", async () => {
    const { store, root } = await scratch();
    const file = path.join(root, "single.jsonl");
    await writeFile(file, JSON.stringify({ type: "session", id: "v1", cwd: "/synthetic/ws" }));
    expect(await store.readHeader(file)).toEqual({ id: "v1", cwd: "/synthetic/ws" });
  });

  it.each([
    ["a missing file", undefined],
    ["an empty file", ""],
    ["text that is not JSON", "hello world\n"],
    ["a JSON array", "[1,2,3]\n"],
    ["another entry type first", `${userEntry("x")}\n`],
    ["a header without id", `${JSON.stringify({ type: "session", cwd: "/synthetic/ws" })}\n`],
    ["a header with an empty cwd", `${JSON.stringify({ type: "session", id: "a", cwd: "" })}\n`],
    ["a header with a numeric id", `${JSON.stringify({ type: "session", id: 7, cwd: "/synthetic/ws" })}\n`],
  ])("returns nothing for %s", async (_label, content) => {
    const { store, root } = await scratch();
    const file = path.join(root, "candidate.jsonl");
    if (content !== undefined) await writeFile(file, content);
    expect(await store.readHeader(file)).toBeUndefined();
  });

  it("does not read past the first 64 KiB of a first line that never ends", async () => {
    const { store, root } = await scratch();
    const file = path.join(root, "huge.jsonl");
    // A syntactically valid header whose closing brace sits beyond the bound.
    await writeFile(file, `{"type":"session","id":"big","cwd":"/synthetic/ws","pad":"${"x".repeat(200_000)}"}\n`);
    expect(await store.readHeader(file)).toBeUndefined();
  });

  it("returns nothing for a directory", async () => {
    const { store, root } = await scratch();
    expect(await store.readHeader(root)).toBeUndefined();
  });
});

describe("PiSessionStore.find", () => {
  it("finds a Bot session by its file-name suffix and confirms the id in the header", async () => {
    const { store, cwd } = await scratch();
    const file = await writeSession(store.sessionDir, "sess-1", cwd, [userEntry("hi"), nameEntry("My session")]);
    const found = await store.find("sess-1", cwd);
    expect(found).toMatchObject({ sessionId: "sess-1", path: file, cwd, origin: "bot", name: "My session", createdAt: "2026-01-02T03:04:05.000Z" });
    expect(Number.isNaN(Date.parse(found!.updatedAt))).toBe(false);
  });

  it("never trusts a file name alone", async () => {
    const { store, cwd } = await scratch();
    // The name claims "wanted" but the header says otherwise.
    await writeSession(store.sessionDir, "someone-else", cwd, [], { fileId: "wanted" });
    expect(await store.find("wanted", cwd)).toBeUndefined();
    // A file whose name merely ends with the id after another id-like prefix still needs the header to agree.
    await writeSession(store.sessionDir, "prefix_wanted2", cwd, [], { fileId: "prefix_wanted2" });
    expect(await store.find("wanted2", cwd)).toBeUndefined();
    expect((await store.find("prefix_wanted2", cwd))?.sessionId).toBe("prefix_wanted2");
  });

  it("ignores unsafe ids, files that are not sessions and other extensions", async () => {
    const { store, cwd } = await scratch();
    await mkdir(store.sessionDir, { recursive: true });
    await writeFile(path.join(store.sessionDir, "2026-01-02T03-04-05-000Z_notes.jsonl"), "not a session\n");
    await writeFile(path.join(store.sessionDir, "2026-01-02T03-04-05-000Z_other.txt"), `${header("other", cwd)}\n`);
    await mkdir(path.join(store.sessionDir, "2026-01-02T03-04-05-000Z_dir.jsonl"));
    expect(await store.find("notes", cwd)).toBeUndefined();
    expect(await store.find("other", cwd)).toBeUndefined();
    expect(await store.find("dir", cwd)).toBeUndefined();
    expect(await store.find("../escape", cwd)).toBeUndefined();
    expect(await store.find("", cwd)).toBeUndefined();
    expect(await store.find("missing", cwd)).toBeUndefined();
  });

  it("finds a session in Pi's own directory for the workspace and reports it as native", async () => {
    const { store, cwd } = await scratch();
    const file = await writeSession(await store.nativeSessionDir(cwd), "native-1", cwd, [userEntry("from the terminal")]);
    expect(await store.find("native-1")).toBeUndefined(); // without a workspace there is no native directory to look in
    expect(await store.find("native-1", cwd)).toMatchObject({ sessionId: "native-1", path: file, origin: "native", cwd });
  });

  it("prefers the Bot's own copy when both directories hold the id", async () => {
    const { store, cwd } = await scratch();
    await writeSession(await store.nativeSessionDir(cwd), "both", cwd);
    const bot = await writeSession(store.sessionDir, "both", cwd);
    expect(await store.find("both", cwd)).toMatchObject({ path: bot, origin: "bot" });
  });

  it("opens a remembered external session in place and forgets nothing when the file is gone", async () => {
    const { store, cwd, root } = await scratch();
    const elsewhere = await writeSession(path.join(root, "elsewhere"), "ext-1", cwd, [nameEntry("External")]);
    expect(await store.find("ext-1", cwd)).toBeUndefined();
    await store.updateRecord("ext-1", { externalPath: elsewhere });
    expect(await store.find("ext-1")).toMatchObject({ sessionId: "ext-1", path: elsewhere, origin: "native", name: "External" });
    await rm(elsewhere);
    expect(await store.find("ext-1", cwd)).toBeUndefined();
    expect((await store.record("ext-1")).externalPath).toBe(elsewhere);
  });

  it("does not accept a remembered path whose header names another session", async () => {
    const { store, cwd, root } = await scratch();
    const elsewhere = await writeSession(path.join(root, "elsewhere"), "real-id", cwd);
    await store.updateRecord("claimed-id", { externalPath: elsewhere });
    expect(await store.find("claimed-id", cwd)).toBeUndefined();
  });

  it("looks in the flat native directory when Pi's session directory is relocated", async () => {
    const { make, cwd, agentDir, root } = await scratch();
    const flat = path.join(root, "flat");
    const store = make({ PI_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_SESSION_DIR: flat });
    const file = await writeSession(flat, "flat-1", cwd);
    expect(await store.find("flat-1", cwd)).toMatchObject({ path: file, origin: "native" });
  });
});

describe("PiSessionStore.list", () => {
  it("lists the workspace's sessions from both directories, newest first", async () => {
    const { store, cwd } = await scratch();
    await writeSession(store.sessionDir, "old-bot", cwd, [], { mtime: 1_000 });
    await writeSession(await store.nativeSessionDir(cwd), "mid-native", cwd, [nameEntry("Terminal work")], { mtime: 2_000 });
    await writeSession(store.sessionDir, "new-bot", cwd, [], { mtime: 3_000 });
    const sessions = await store.list({ cwd });
    expect(sessions.map(session => [session.sessionId, session.origin])).toEqual([["new-bot", "bot"], ["mid-native", "native"], ["old-bot", "bot"]]);
    expect(sessions[1]!.name).toBe("Terminal work");
    expect(sessions[0]!.updatedAt).toBe(new Date(3_000_000).toISOString());
  });

  it("leaves out sessions of other workspaces, non-sessions and duplicates", async () => {
    const { store, cwd, root } = await scratch();
    const other = path.join(root, "other-workspace");
    await writeSession(store.sessionDir, "mine", cwd, [], { mtime: 5_000 });
    await writeSession(store.sessionDir, "theirs", other, [], { mtime: 6_000 });
    await writeFile(path.join(store.sessionDir, "garbage.jsonl"), "{\n");
    await writeFile(path.join(store.sessionDir, "readme.txt"), "x");
    // The same id in Pi's own directory, older: the newer file wins and it is listed once.
    await writeSession(await store.nativeSessionDir(cwd), "mine", cwd, [], { mtime: 4_000 });
    const sessions = await store.list({ cwd });
    expect(sessions.map(session => session.sessionId)).toEqual(["mine"]);
    expect(sessions[0]!.origin).toBe("bot");
    expect((await store.list({ cwd: other })).map(session => session.sessionId)).toEqual(["theirs"]);
  });

  it("matches the workspace after resolving both paths", async () => {
    const { store, cwd } = await scratch();
    await writeSession(store.sessionDir, "dotted", `${cwd}${path.sep}.`, []);
    expect((await store.list({ cwd: `${cwd}${path.sep}` })).map(session => session.sessionId)).toEqual(["dotted"]);
  });

  it("honours the limit and clamps a nonsensical one", async () => {
    const { store, cwd } = await scratch();
    for (let index = 1; index <= 5; index++) await writeSession(store.sessionDir, `s${index}`, cwd, [], { mtime: index * 1_000 });
    expect((await store.list({ cwd, limit: 2 })).map(session => session.sessionId)).toEqual(["s5", "s4"]);
    expect((await store.list({ cwd, limit: 0 })).map(session => session.sessionId)).toEqual(["s5"]);
    expect((await store.list({ cwd, limit: -3 })).map(session => session.sessionId)).toEqual(["s5"]);
    expect(await store.list({ cwd })).toHaveLength(5);
  });

  it("returns an empty list when neither directory exists", async () => {
    const { store, cwd } = await scratch();
    expect(await store.list({ cwd })).toEqual([]);
  });

  it("uses the latest session_info entry as the name, including a cleared one", async () => {
    const { store, cwd } = await scratch();
    await writeSession(store.sessionDir, "renamed", cwd, [nameEntry("first", 1), userEntry("x"), nameEntry("  second  ", 2)], { mtime: 3_000 });
    await writeSession(store.sessionDir, "cleared", cwd, [nameEntry("had a name", 1), nameEntry(undefined, 2)], { mtime: 2_000 });
    await writeSession(store.sessionDir, "blank", cwd, [nameEntry("   ", 1)], { mtime: 1_500 });
    await writeSession(store.sessionDir, "unnamed", cwd, [userEntry("x")], { mtime: 1_000 });
    const byId = Object.fromEntries((await store.list({ cwd })).map(session => [session.sessionId, session]));
    expect(byId.renamed!.name).toBe("second");
    expect("name" in byId.cleared!).toBe(false);
    expect("name" in byId.blank!).toBe(false);
    expect("name" in byId.unnamed!).toBe(false);
  });

  it("does not take a name from message text that merely quotes a session_info entry", async () => {
    const { store, cwd } = await scratch();
    const quoted = userEntry(`please explain {"type":"session_info","name":"injected"} to me`);
    await writeSession(store.sessionDir, "quoted", cwd, [nameEntry("real name"), quoted, `${JSON.stringify({ type: "custom", data: "session_info" })}`]);
    expect((await store.list({ cwd }))[0]!.name).toBe("real name");
  });

  it("reads the name from a last line that has no newline and bounds its length", async () => {
    const { store, cwd } = await scratch();
    await mkdir(store.sessionDir, { recursive: true });
    await writeFile(path.join(store.sessionDir, "2026-01-02T03-04-05-000Z_tail.jsonl"), `${header("tail", cwd)}\n${nameEntry("n".repeat(500))}`);
    const [session] = await store.list({ cwd });
    expect(session!.name).toBe("n".repeat(200));
  });
});

describe("PiSessionStore state", () => {
  it("round-trips a session record and persists it for the next instance", async () => {
    const { store, make, stateDir } = await scratch();
    expect(await store.record("s1")).toEqual({});
    const before = Date.now();
    const saved = await store.updateRecord("s1", { appliedBotDefault: "abc", modelSource: "bot-default", botDefaultModel: { provider: "p", modelId: "m/with/slash" } });
    expect(saved).toMatchObject({ appliedBotDefault: "abc", modelSource: "bot-default", botDefaultModel: { provider: "p", modelId: "m/with/slash" } });
    expect(saved.touchedAt).toBeGreaterThanOrEqual(before);
    const reloaded = await make().record("s1");
    expect(reloaded).toEqual(saved);
    const file = path.join(stateDir, "pi", "state.json");
    const onDisk = JSON.parse(await readFile(file, "utf8")) as { version: number; sessions: Record<string, unknown>; trust: Record<string, unknown> };
    expect(onDisk.version).toBe(1);
    expect(onDisk.sessions.s1).toEqual(saved);
    expect(onDisk.trust).toEqual({});
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("returns copies, so a caller cannot change stored state by mutating a result", async () => {
    const { store } = await scratch();
    const saved = await store.updateRecord("s1", { appliedBotDefault: "abc" });
    saved.appliedBotDefault = "tampered";
    const read = await store.record("s1");
    read.modelSource = "ticket";
    expect(await store.record("s1")).toMatchObject({ appliedBotDefault: "abc" });
    expect((await store.record("s1")).modelSource).toBeUndefined();
  });

  it("merges patches and removes a field patched to undefined", async () => {
    const { store, make } = await scratch();
    await store.updateRecord("s1", { appliedBotDefault: "abc", modelSource: "bot-default", botDefaultModel: { provider: "p", modelId: "m" } });
    const next = await store.updateRecord("s1", { modelSource: "session", botDefaultModel: undefined });
    expect(next.appliedBotDefault).toBe("abc");
    expect(next.modelSource).toBe("session");
    expect("botDefaultModel" in next).toBe(false);
    expect("botDefaultModel" in (await make().record("s1"))).toBe(false);
  });

  it("changes a record conditionally only if the condition still holds once the file has been read", async () => {
    const { store, make } = await scratch();
    await store.updateRecord("s1", { appliedBotDefault: "abc" });
    // A fresh instance has to read the file first; the condition turns false during that wait.
    const fresh = make();
    let holds = true;
    const pending = fresh.updateRecordIf("s1", { modelSource: "session" }, () => holds);
    holds = false;
    expect(await pending).toBe(false);
    expect(await fresh.record("s1")).toEqual(await store.record("s1"));
    expect((await make().record("s1")).modelSource).toBeUndefined();
    holds = true;
    expect(await fresh.updateRecordIf("s1", { modelSource: "session" }, () => holds)).toBe(true);
    expect(await make().record("s1")).toMatchObject({ appliedBotDefault: "abc", modelSource: "session" });
  });

  it("writes atomically and leaves no temporary file, also under concurrent updates", async () => {
    const { store, make, stateDir } = await scratch();
    await Promise.all(Array.from({ length: 25 }, (_unused, index) => store.updateRecord(`s${index}`, { appliedBotDefault: `f${index}` })));
    const files = await readdir(path.join(stateDir, "pi"));
    expect(files.sort()).toEqual(["state.json"]);
    const reloaded = make();
    for (let index = 0; index < 25; index++) expect((await reloaded.record(`s${index}`)).appliedBotDefault).toBe(`f${index}`);
  });

  it("shares one in-memory state between concurrent first uses", async () => {
    const { store, make } = await scratch();
    await Promise.all([store.updateRecord("a", { appliedBotDefault: "1" }), store.setTrustDecision("/synthetic/ws", "yes"), store.updateRecord("b", { appliedBotDefault: "2" })]);
    const reloaded = make();
    expect((await reloaded.record("a")).appliedBotDefault).toBe("1");
    expect((await reloaded.record("b")).appliedBotDefault).toBe("2");
    expect(await reloaded.trustDecision("/synthetic/ws")).toBe("yes");
  });

  it.each(["EACCES", "EIO"])("preserves existing settings when the first state read fails with %s, and retries after recovery", async code => {
    const { store, make, stateDir } = await scratch();
    await store.updateRecord("kept", { appliedBotDefault: "original", modelSource: "session" });
    await store.setTrustDecision("/synthetic/kept", "no");
    await store.setScopedModels(["provider/model"]);
    const file = path.join(stateDir, "pi", "state.json");
    const before = await readFile(file, "utf8");
    readFault.file = file; readFault.code = code;
    const fresh = make();
    const attempts = await Promise.allSettled([
      fresh.updateRecord("new", { appliedBotDefault: "must-not-write" }),
      fresh.setTrustDecision("/synthetic/new", "yes"),
      fresh.setScopedModels(["other/model"]),
    ]);
    readFault.code = "";
    expect(attempts.map(result => result.status)).toEqual(["rejected", "rejected", "rejected"]);
    expect(readFault.reads).toBe(1);
    expect(await readFile(file, "utf8")).toBe(before);
    // The failed load must not remain cached, and failed mutations must not be replayed.
    await fresh.updateRecord("recovered", { appliedBotDefault: "new" });
    const reloaded = make();
    expect(await reloaded.record("kept")).toMatchObject({ appliedBotDefault: "original", modelSource: "session" });
    expect(await reloaded.record("new")).toEqual({});
    expect(await reloaded.trustDecision("/synthetic/kept")).toBe("no");
    expect(await reloaded.trustDecision("/synthetic/new")).toBeUndefined();
    expect(await reloaded.scopedModels()).toEqual(["provider/model"]);
    expect(await reloaded.record("recovered")).toMatchObject({ appliedBotDefault: "new" });
  });

  it("does not cache empty state after a real read error, and can read a repaired state path", async () => {
    const { store, stateDir } = await scratch();
    const file = path.join(stateDir, "pi", "state.json");
    // A directory at a file path deterministically fails readFile on macOS/Linux/Windows.
    await mkdir(file, { recursive: true });
    await expect(store.record("kept")).rejects.toBeInstanceOf(Error);
    expect((await stat(file)).isDirectory()).toBe(true);
    await rm(file, { recursive: true });
    await writeFile(file, JSON.stringify({ version: 1, sessions: { kept: { appliedBotDefault: "original" } }, trust: {} }));
    expect(await store.record("kept")).toMatchObject({ appliedBotDefault: "original" });
  });

  it.each([
    ["text that is not JSON", "this is not json"],
    ["a JSON array", "[1,2]"],
    ["null", "null"],
    ["wrongly shaped sections", JSON.stringify({ version: 1, sessions: ["a"], trust: "yes" })],
    ["an empty file", ""],
  ])("starts empty when the state file holds %s, and repairs it on the next write", async (_label, content) => {
    const { store, make, stateDir } = await scratch();
    await mkdir(path.join(stateDir, "pi"), { recursive: true });
    await writeFile(path.join(stateDir, "pi", "state.json"), content);
    expect(await store.record("s1")).toEqual({});
    expect(await store.trustDecision("/synthetic/ws")).toBeUndefined();
    await store.updateRecord("s1", { appliedBotDefault: "abc" });
    expect((await make().record("s1")).appliedBotDefault).toBe("abc");
  });

  it("keeps unknown fields of an existing record when it is updated", async () => {
    const { store, make, stateDir } = await scratch();
    await mkdir(path.join(stateDir, "pi"), { recursive: true });
    await writeFile(path.join(stateDir, "pi", "state.json"), JSON.stringify({ version: 1, sessions: { s1: { appliedBotDefault: "old", fromANewerBuild: 7 } }, trust: {} }));
    await store.updateRecord("s1", { appliedBotDefault: "new" });
    expect(await make().record("s1")).toMatchObject({ appliedBotDefault: "new", fromANewerBuild: 7 });
  });

  it("keeps at most 1000 session records, dropping the least recently touched", async () => {
    const { store, make, stateDir } = await scratch();
    const sessions: Record<string, unknown> = {};
    for (let index = 0; index < 1005; index++) sessions[`old-${index}`] = { appliedBotDefault: "x", touchedAt: index + 1 };
    await mkdir(path.join(stateDir, "pi"), { recursive: true });
    await writeFile(path.join(stateDir, "pi", "state.json"), JSON.stringify({ version: 1, sessions, trust: {} }));
    await store.updateRecord("fresh", { appliedBotDefault: "y" });
    const onDisk = JSON.parse(await readFile(path.join(stateDir, "pi", "state.json"), "utf8")) as { sessions: Record<string, unknown> };
    const ids = Object.keys(onDisk.sessions);
    expect(ids).toHaveLength(1000);
    expect(ids).toContain("fresh");
    for (let index = 0; index < 6; index++) expect(ids, `old-${index}`).not.toContain(`old-${index}`);
    expect(ids).toContain("old-6");
    expect(ids).toContain("old-1004");
    expect(await make().record("old-0")).toEqual({});
  });

  it("lets a fork or clone inherit the applied defaults but not an external path", async () => {
    const { store } = await scratch();
    await store.updateRecord("parent", { appliedBotDefault: "fp", modelSource: "session", botDefaultModel: { provider: "p", modelId: "m" }, externalPath: "/synthetic/elsewhere/parent.jsonl" });
    await store.inheritRecord("parent", "child");
    const child = await store.record("child");
    expect(child).toMatchObject({ appliedBotDefault: "fp", modelSource: "session", botDefaultModel: { provider: "p", modelId: "m" } });
    expect("externalPath" in child).toBe(false);
    expect((await store.record("parent")).externalPath).toBe("/synthetic/elsewhere/parent.jsonl");
    await store.inheritRecord("never-seen", "orphan");
    const orphan = await store.record("orphan");
    expect(Object.keys(orphan)).toEqual(["touchedAt"]);
  });

  it("remembers the owner's trust answer per workspace", async () => {
    const { store, make, root } = await scratch();
    const first = path.join(root, "one"), second = path.join(root, "two");
    expect(await store.trustDecision(first)).toBeUndefined();
    await store.setTrustDecision(first, "yes");
    await store.setTrustDecision(second, "no");
    expect(await store.trustDecision(first)).toBe("yes");
    expect(await store.trustDecision(`${first}${path.sep}`)).toBe("yes");
    expect(await store.trustDecision(path.join(first, "sub", ".."))).toBe("yes");
    expect(await store.trustDecision(second)).toBe("no");
    expect(await store.trustDecision(path.join(first, "sub"))).toBeUndefined();
    await store.setTrustDecision(first, "no");
    const reloaded = make();
    expect(await reloaded.trustDecision(first)).toBe("no");
    expect(await reloaded.trustDecision(second)).toBe("no");
  });

  it("does not store workspace paths in the trust table", async () => {
    const { store, stateDir, root } = await scratch();
    const workspace = path.join(root, "confidential-client-name");
    await store.setTrustDecision(workspace, "yes");
    const text = await readFile(path.join(stateDir, "pi", "state.json"), "utf8");
    expect(text).not.toContain("confidential-client-name");
  });
});

describe("piBotDefaultFingerprint", () => {
  it("is stable, short, and separates model from effort", () => {
    const fingerprint = piBotDefaultFingerprint("anthropic/claude-x", "high");
    expect(fingerprint).toMatch(/^[0-9a-f]{32}$/);
    expect(piBotDefaultFingerprint("anthropic/claude-x", "high")).toBe(fingerprint);
    expect(piBotDefaultFingerprint("anthropic/claude-x", "low")).not.toBe(fingerprint);
    expect(piBotDefaultFingerprint("anthropic/claude-y", "high")).not.toBe(fingerprint);
    // Concatenation would make these collide.
    expect(piBotDefaultFingerprint("ab", "")).not.toBe(piBotDefaultFingerprint("a", "b"));
    expect(piBotDefaultFingerprint("a", "b")).not.toBe(piBotDefaultFingerprint("b", "a"));
  });

  it("treats an absent value and an empty one as the same cleared default", () => {
    expect(piBotDefaultFingerprint(undefined, undefined)).toBe(piBotDefaultFingerprint("", ""));
    expect(piBotDefaultFingerprint(undefined, "off")).toBe(piBotDefaultFingerprint("", "off"));
    expect(piBotDefaultFingerprint(undefined, "off")).not.toBe(piBotDefaultFingerprint(undefined, undefined));
  });
});

describe("PiSessionStore import destination", () => {
  it("names an imported copy so the store finds it by id again, whatever the source was called", async () => {
    const { root, cwd, store } = await scratch();
    await store.ensureDirs();
    const sources = [["backup.jsonl", "abc-1"], ["notes.txt", "abc-2"], ["2026-01-02T03-04-05-000Z_abc-3.jsonl", "abc-3"], ["under_score.and.dots.jsonl", "abc-4"]] as const;
    for (const [source, id] of sources) {
      const from = path.join(root, source);
      await writeFile(from, `${header(id, cwd)}\n`);
      const destination = await store.importDestination(from, id);
      expect(path.dirname(destination)).toBe(store.sessionDir);
      // The id is in the name, as in Pi's own files: no header has to be read to find it again.
      expect(path.basename(destination).endsWith(`_${id}.jsonl`)).toBe(true);
      await copyFile(from, destination);
      expect(await store.find(id)).toMatchObject({ sessionId: id, path: destination, origin: "bot" });
    }
    // A source that already carries Pi's own name keeps it.
    expect((await readdir(store.sessionDir)).sort()).toContain("2026-01-02T03-04-05-000Z_abc-3.jsonl");
    expect((await store.list({ cwd })).map(session => session.sessionId).sort()).toEqual(["abc-1", "abc-2", "abc-3", "abc-4"]);
  });

  it("keeps the id at the end when the name is taken, and keeps the name within one path component", async () => {
    const { root, cwd, store } = await scratch();
    await store.ensureDirs();
    const from = path.join(root, "backup.jsonl");
    await writeFile(from, `${header("abc-1", cwd)}\n`);
    const first = await store.importDestination(from, "abc-1");
    // Something else already sits under that name (a leftover with another header).
    await writeFile(first, `${header("someone-else", cwd)}\n`);
    const second = await store.importDestination(from, "abc-1");
    expect(second).not.toBe(first);
    expect(path.basename(second)).toBe("backup-1_abc-1.jsonl");
    await copyFile(from, second);
    expect(await store.find("abc-1")).toMatchObject({ sessionId: "abc-1", path: second });

    const long = await store.importDestination(path.join(root, `${"长".repeat(120)}.jsonl`), "a".repeat(128));
    expect(Buffer.byteLength(path.basename(long))).toBeLessThanOrEqual(255);
    expect(path.basename(long).endsWith(`_${"a".repeat(128)}.jsonl`)).toBe(true);
    await expect(store.importDestination(from, "../escape")).rejects.toThrow(/session id/i);
  });
});

describe("PiSessionStore sessions imported before copies were named by id", () => {
  it("finds a copy that kept the owner's file name by its header, and only opens files Pi did not name itself", async () => {
    const { cwd, store } = await scratch();
    await store.ensureDirs();
    await writeFile(path.join(store.sessionDir, "backup.jsonl"), `${header("legacy-1", cwd)}\n${nameEntry("Old import")}\n`);
    await writeFile(path.join(store.sessionDir, "notes.txt"), `${header("legacy-2", cwd)}\n`);
    await writeFile(path.join(store.sessionDir, "2026-01-02T03-04-05-000Z_5f0c3a52-8b0e-4c59-9f43-0d6f1a2b3c4d-1.jsonl"), `${header("legacy-3", cwd)}\n`);
    expect(await store.find("legacy-1")).toMatchObject({ sessionId: "legacy-1", path: path.join(store.sessionDir, "backup.jsonl"), origin: "bot", name: "Old import", cwd });
    // Other extensions are still not session files, here as in a listing.
    expect(await store.find("legacy-2")).toBeUndefined();
    expect(await store.find("legacy-3")).toMatchObject({ sessionId: "legacy-3" });
    expect(await store.find("legacy-9")).toBeUndefined();

    // A file Pi named itself carries its id in the name: it is never opened to look for another id,
    // so a Bot with thousands of ordinary sessions pays nothing for this.
    const own = path.join(store.sessionDir, "2026-01-02T03-04-05-000Z_5f0c3a52-8b0e-4c59-9f43-0d6f1a2b3c4d.jsonl");
    await writeFile(own, `${header("renamed-by-hand", cwd)}\n`);
    expect(await store.find("renamed-by-hand")).toBeUndefined();
    expect(await store.find("5f0c3a52-8b0e-4c59-9f43-0d6f1a2b3c4d")).toBeUndefined();
  });

  it("prefers the copy that was written last when an old double import left two files with one id", async () => {
    const { cwd, store } = await scratch();
    await store.ensureDirs();
    const first = path.join(store.sessionDir, "backup.jsonl"), second = path.join(store.sessionDir, "backup-1.jsonl");
    await writeFile(first, `${header("legacy-1", cwd)}\n`); await writeFile(second, `${header("legacy-1", cwd)}\n`);
    await utimes(first, new Date(2_000_000_000_000), new Date(2_000_000_000_000));
    await utimes(second, new Date(1_900_000_000_000), new Date(1_900_000_000_000));
    expect((await store.find("legacy-1"))?.path).toBe(first);
    await utimes(second, new Date(2_100_000_000_000), new Date(2_100_000_000_000));
    expect((await store.find("legacy-1"))?.path).toBe(second);
    // A copy under the current naming is the one an import made on purpose; it wins over leftovers.
    const named = path.join(store.sessionDir, "backup_legacy-1.jsonl");
    await writeFile(named, `${header("legacy-1", cwd)}\n`);
    await utimes(named, new Date(1_800_000_000_000), new Date(1_800_000_000_000));
    expect((await store.find("legacy-1"))?.path).toBe(named);
  });

  it("does not hand out a file that was replaced by another session between its two reads", async () => {
    const { cwd, store } = await scratch();
    await store.ensureDirs();
    const kept = path.join(store.sessionDir, "backup.jsonl");
    await writeFile(kept, `${header("legacy-1", cwd)}\n`);
    // The lookup reads a match once for its id and once more for its name. Swap the file in between.
    const target = store as unknown as { describe(file: string, origin: string, withName: boolean): Promise<unknown> };
    const describe = target.describe.bind(store);
    target.describe = async (file, origin, withName) => {
      if (withName && file === kept) await writeFile(kept, `${header("someone-else", cwd)}\n${nameEntry("Not yours")}\n`);
      return describe(file, origin, withName);
    };
    expect(await store.find("legacy-1")).toBeUndefined();
    expect(await store.find("someone-else")).toMatchObject({ sessionId: "someone-else", name: "Not yours" });
  });

  it("looks at a bounded number of such files", async () => {
    const { cwd, store } = await scratch();
    await store.ensureDirs();
    await Promise.all(Array.from({ length: 260 }, (_, index) => writeFile(path.join(store.sessionDir, `copy-${String(index).padStart(3, "0")}.jsonl`), `${header(`bulk-${index}`, cwd)}\n`)));
    expect(await store.find("bulk-0")).toMatchObject({ sessionId: "bulk-0" });
    expect(await store.find("bulk-199")).toMatchObject({ sessionId: "bulk-199" });
    expect(await store.find("bulk-259")).toBeUndefined();
  });
});

describe("hasPiTrustGatedFiles", () => {
  it("is false for a workspace without project-local Pi files", async () => {
    const { cwd } = await scratch();
    expect(await hasPiTrustGatedFiles(cwd)).toBe(false);
    await mkdir(path.join(cwd, ".pi", "notes"), { recursive: true });
    await writeFile(path.join(cwd, "AGENTS.md"), "context files are not trust-gated");
    await mkdir(path.join(cwd, ".agents", "other"), { recursive: true });
    expect(await hasPiTrustGatedFiles(cwd)).toBe(false);
    expect(await hasPiTrustGatedFiles(path.join(cwd, "missing"))).toBe(false);
  });

  it.each([...PI_TRUST_GATED_PATHS])("is true when %s exists", async relative => {
    const { cwd } = await scratch();
    const target = path.join(cwd, relative);
    if (/\.(?:json|md)$/i.test(relative)) { await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, "{}"); }
    else await mkdir(target, { recursive: true });
    expect(await hasPiTrustGatedFiles(cwd)).toBe(true);
  });

  it("covers the nine paths Pi 1.5.2 gates", () => {
    expect([...PI_TRUST_GATED_PATHS].sort()).toEqual([
      ".agents/skills", ".pi/APPEND_SYSTEM.md", ".pi/SYSTEM.md", ".pi/extensions", ".pi/mcp.json", ".pi/prompts",
      ".pi/settings.json", ".pi/skills", ".pi/themes",
    ]);
    expect(Object.isFrozen(PI_TRUST_GATED_PATHS)).toBe(true);
  });
});
