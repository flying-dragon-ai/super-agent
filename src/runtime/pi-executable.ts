import path from "node:path";
import { executableCandidates, resolveEngineExecutable } from "./engine-process.js";

/**
 * The file a Pi launch runs. A bare name is resolved here, through absolute PATH directories only,
 * to an absolute file, or not at all; it is never left to the platform search, which on Windows
 * (cmd.exe, libuv, cross-spawn's `which`) looks in the child's working directory, the workspace,
 * first. An explicit path is the owner's setting and is returned unchanged.
 */
export function resolvePiLaunchCommand(command: string, env: NodeJS.ProcessEnv, platform = process.platform): string | undefined {
  const windows = platform === "win32";
  const name = command.trim().replace(/^"(.*)"$/, "$1");
  if (!name) return undefined;
  if (windows ? /[\\/]/.test(name) : name.includes("/")) return command;
  const absolute = (file: string) => windows ? /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/.test(file) : path.posix.isAbsolute(file);
  for (const file of executableCandidates(name, env, platform)) {
    const found = absolute(file) ? resolveEngineExecutable(file, env, platform) : undefined;
    if (found) return found;
  }
  return undefined;
}

/** Shared by launch, Doctor, settings and availability. Prefer the user's
 * selection; only inspect known installer paths, never execute candidates. */
export function resolvePiExecutable(env: NodeJS.ProcessEnv, platform = process.platform): string {
  const windows = platform === "win32", p = windows ? path.win32 : path.posix;
  const value = (key: string) => env[key] ?? (windows ? Object.entries(env).find(([name]) => name.toUpperCase() === key)?.[1] : undefined);
  const explicit = value("PI_EXECUTABLE");
  if (explicit !== undefined && explicit !== "") return explicit.trim().replace(/^"(.*)"$/, "$1");
  if (resolveEngineExecutable("pi", env, platform)) return "pi";
  const absolute = (candidate: string | undefined) => candidate && !/[\x00-\x1f\x7f]/.test(candidate)
    && (windows ? /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/.test(candidate) : p.isAbsolute(candidate)) ? candidate : undefined;
  const home = absolute(value(windows ? "USERPROFILE" : "HOME"));
  const roaming = absolute(value("APPDATA")) ?? (home && p.join(home, "AppData", "Roaming"));
  const agent = absolute(value("PI_CODING_AGENT_DIR")) ?? (home && p.join(home, ".pi", "agent"));
  const candidates = [
    ...(windows && roaming ? [p.join(roaming, "npm", "pi.cmd")] : []),
    ...(agent ? [p.join(agent, "bin", windows ? "pi.cmd" : "pi")] : []),
  ];
  return candidates.find(file => resolveEngineExecutable(file, env, platform)) ?? "pi";
}
