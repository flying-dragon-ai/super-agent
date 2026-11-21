import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { searchMcpBlocksManaged, type NativeSearchMcpPlan, type SearchMcpEntry } from "../runtime/native-search-mcp.js";
import { escapePiConfigLiteral } from "./pi-bridge-host.js";
import { piAgentDir } from "./pi-session-store.js";

/**
 * The Host-managed Search MCP for a Pi session. It is registered for one
 * process through the bridge (`pi.registerMcpServer`), never written to the
 * owner's `mcp.json`. Credentials travel over the bridge socket as the MCP
 * child's environment; they are not placed in Pi's own environment (which the
 * model's shell tool inherits), in arguments, in logs or in the session file.
 */

const MAX_CONFIG_BYTES = 2 * 1024 * 1024;
class UnreadablePiMcpConfig extends Error {}

async function readMcpServers(file: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_CONFIG_BYTES) throw new UnreadablePiMcpConfig();
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    // Contents never enter diagnostics; the caller only learns the file was unusable.
    throw new UnreadablePiMcpConfig();
  }
  try {
    const servers = (JSON.parse(text) as { mcpServers?: unknown } | null)?.mcpServers;
    return servers && typeof servers === "object" && !Array.isArray(servers) ? servers as Record<string, unknown> : {};
  } catch { throw new UnreadablePiMcpConfig(); }
}

/** The owner's Pi MCP registrations for this workspace: global `mcp.json` and the project's `.pi/mcp.json`. */
export async function collectPiSearchMcpEntries(env: NodeJS.ProcessEnv, workspacePath: string, homeDir?: string): Promise<SearchMcpEntry[]> {
  // Pi runs in the workspace, so a relative PI_CODING_AGENT_DIR is read from there.
  const files = [path.join(piAgentDir(env, homeDir, workspacePath), "mcp.json"), path.join(workspacePath, ".pi", "mcp.json")];
  const entries: SearchMcpEntry[] = [];
  for (const file of files) {
    for (const [name, server] of Object.entries(await readMcpServers(file))) {
      const record = server && typeof server === "object" && !Array.isArray(server) ? server as Record<string, unknown> : {};
      entries.push({ name, server: record, disabled: record.enabled === false });
    }
  }
  return entries;
}

export interface PiManagedSearchServer {
  name: string;
  /** For `PiBridgeConnection.setMcpServers`. Contains credential values: never log it. */
  config: Record<string, unknown>;
  /** Pi names MCP tools `mcp__<server>__<tool>`. */
  toolPrefix: string;
}

/**
 * The managed server to register, or null when there is no plan or the owner
 * already has a search server (working or deliberately disabled). An
 * unreadable configuration also yields null: a duplicate cannot be ruled out.
 */
export async function piManagedSearchServer(
  plan: NativeSearchMcpPlan | null, env: NodeJS.ProcessEnv, workspacePath: string, homeDir?: string,
): Promise<PiManagedSearchServer | null> {
  if (!plan) return null;
  try {
    if (searchMcpBlocksManaged(await collectPiSearchMcpEntries(env, workspacePath, homeDir))) return null;
  } catch {
    console.error("[search] Pi MCP configuration unreadable; not adding the managed Search MCP.");
    return null;
  }
  const childEnv: Record<string, string> = {};
  for (const key of plan.envKeys) {
    const value = plan.processEnv[key] ?? env[key];
    // Pi treats env values as templates ($NAME, !command); a credential must be taken literally.
    if (typeof value === "string") childEnv[key] = escapePiConfigLiteral(value);
  }
  return {
    name: plan.name,
    toolPrefix: `mcp__${plan.name.replace(/-/g, "_")}__`,
    config: {
      command: plan.command, args: [...plan.args], env: childEnv,
      // Pi's default exposure hides MCP tools behind codemode; search has to be callable directly.
      exposure: "direct",
      description: "Web search and page extraction provided by open-super-agent.",
    },
  };
}
