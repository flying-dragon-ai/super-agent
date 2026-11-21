import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { collectPiSearchMcpEntries, piManagedSearchServer } from "../src/codex/pi-search-mcp.js";
import { MANAGED_SEARCH_MCP_NAME, type NativeSearchMcpPlan } from "../src/runtime/native-search-mcp.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function layout(files: { global?: unknown; project?: unknown } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-search-mcp-"));
  roots.push(root);
  const agentDir = path.join(root, "agent"), workspace = path.join(root, "ws");
  await mkdir(agentDir, { recursive: true });
  await mkdir(path.join(workspace, ".pi"), { recursive: true });
  const write = (file: string, value: unknown) => writeFile(file, typeof value === "string" ? value : JSON.stringify(value));
  if (files.global !== undefined) await write(path.join(agentDir, "mcp.json"), files.global);
  if (files.project !== undefined) await write(path.join(workspace, ".pi", "mcp.json"), files.project);
  return { env: { PI_CODING_AGENT_DIR: agentDir } as NodeJS.ProcessEnv, workspace };
}

const plan = (extra: Partial<NativeSearchMcpPlan> = {}): NativeSearchMcpPlan => ({
  name: MANAGED_SEARCH_MCP_NAME, command: "/synthetic/node", args: ["/synthetic/search-mcp.js"],
  envKeys: ["BRAVE_API_KEY", "TAVILY_API_KEY", "ABSENT_KEY"], processEnv: { BRAVE_API_KEY: "!starts$with-bang" }, ...extra,
});

describe("collectPiSearchMcpEntries", () => {
  it("reads the owner's global and project registrations, with their disabled state", async () => {
    const { env, workspace } = await layout({
      global: { mcpServers: { jira: { url: "https://mcp.example.test/jira" }, parked: { command: "npx", args: ["x"], enabled: false } } },
      project: { mcpServers: { local: { command: "node", args: ["server.js"] } } },
    });
    expect(await collectPiSearchMcpEntries(env, workspace)).toEqual([
      { name: "jira", server: { url: "https://mcp.example.test/jira" }, disabled: false },
      { name: "parked", server: { command: "npx", args: ["x"], enabled: false }, disabled: true },
      { name: "local", server: { command: "node", args: ["server.js"] }, disabled: false },
    ]);
  });

  it("reads a relative PI_CODING_AGENT_DIR from the workspace, where Pi runs, not from the Host's directory", async () => {
    const { workspace } = await layout();
    await mkdir(path.join(workspace, ".native-agent"), { recursive: true });
    await writeFile(path.join(workspace, ".native-agent", "mcp.json"), JSON.stringify({ mcpServers: { relative: { command: "node" } } }));
    expect(await collectPiSearchMcpEntries({ PI_CODING_AGENT_DIR: ".native-agent" }, workspace)).toEqual([
      { name: "relative", server: { command: "node" }, disabled: false },
    ]);
  });

  it("treats missing files and files without servers as empty", async () => {
    const none = await layout();
    expect(await collectPiSearchMcpEntries(none.env, none.workspace)).toEqual([]);
    const empty = await layout({ global: {}, project: { mcpServers: [] } });
    expect(await collectPiSearchMcpEntries(empty.env, empty.workspace)).toEqual([]);
  });

  it("fails on a configuration it cannot read rather than assuming there is none", async () => {
    const broken = await layout({ global: "{ not json" });
    await expect(collectPiSearchMcpEntries(broken.env, broken.workspace)).rejects.toThrow();
  });
});

describe("piManagedSearchServer", () => {
  it("is absent without a plan", async () => {
    const { env, workspace } = await layout();
    expect(await piManagedSearchServer(null, env, workspace)).toBeNull();
  });

  it("describes a per-process stdio server whose credentials are literal values for the server only", async () => {
    const { env, workspace } = await layout({ global: { mcpServers: { jira: { url: "https://mcp.example.test/jira" } } } });
    const server = await piManagedSearchServer(plan(), { ...env, TAVILY_API_KEY: "from-$env" }, workspace);
    expect(server).toEqual({
      name: MANAGED_SEARCH_MCP_NAME,
      toolPrefix: `mcp__${MANAGED_SEARCH_MCP_NAME}__`,
      config: {
        command: "/synthetic/node", args: ["/synthetic/search-mcp.js"], exposure: "direct",
        description: expect.any(String),
        // Pi reads `$NAME` and a leading `!` in env values as templates; both are escaped. A key with no value is left out.
        env: { BRAVE_API_KEY: "$!starts$$with-bang", TAVILY_API_KEY: "from-$$env" },
      },
    });
  });

  it("uses Pi's namespace form for the tool prefix", async () => {
    const { env, workspace } = await layout();
    expect((await piManagedSearchServer(plan({ name: "open-super-agent-search" }), env, workspace))!.toolPrefix).toBe("mcp__open_super_agent_search__");
  });

  it.each([
    ["a working search server of the owner's", { mcpServers: { "brave-search": { command: "npx", args: ["-y", "server-brave-search"] } } }],
    ["a search server the owner disabled", { mcpServers: { tavily: { command: "npx", args: ["tavily-mcp"], enabled: false } } }],
    ["a server registered under the managed name", { mcpServers: { [MANAGED_SEARCH_MCP_NAME]: { command: "node", args: ["mine.js"] } } }],
  ])("steps aside for %s", async (_label, global) => {
    const { env, workspace } = await layout({ global });
    expect(await piManagedSearchServer(plan(), env, workspace)).toBeNull();
  });

  it("also respects a search server in the project file", async () => {
    const { env, workspace } = await layout({ project: { mcpServers: { "web-search": { command: "npx", args: ["something"] } } } });
    expect(await piManagedSearchServer(plan(), env, workspace)).toBeNull();
  });

  it("adds nothing, and says so once, when the configuration is unreadable", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { env, workspace } = await layout({ global: "{ not json" });
    expect(await piManagedSearchServer(plan(), env, workspace)).toBeNull();
    expect(error).toHaveBeenCalledTimes(1);
    // The message must not carry file contents or credential values.
    expect(String(error.mock.calls[0]![0])).not.toMatch(/not json|bang/);
  });
});
