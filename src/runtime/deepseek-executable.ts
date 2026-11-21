import path from "node:path";
import { resolveEngineExecutable } from "./engine-process.js";

type DeepSeekEnvironment = Partial<Record<"DSH_EXECUTABLE" | "APPDATA" | "LOCALAPPDATA" | "USERPROFILE" | "PATH" | "PATHEXT", string>>;

function value(env: DeepSeekEnvironment, key: keyof DeepSeekEnvironment, platform: NodeJS.Platform): string | undefined {
  return env[key] ?? (platform === "win32" ? Object.entries(env).find(([name, entry]) => name.toUpperCase() === key && entry !== undefined)?.[1] : undefined);
}
export function deepseekExecutableOverride(env: DeepSeekEnvironment, platform = process.platform): string | undefined {
  const explicit = value(env, "DSH_EXECUTABLE", platform);
  // An explicitly configured but missing program must not select another CLI.
  return explicit ? explicit.trim().replace(/^"(.*)"$/, "$1") : undefined;
}

/** Shared default selection for launch, availability, settings and Doctor.
 * Only inspect files; never run a candidate, modify PATH or persist an override.
 * Unix discovery remains owned by the existing PATH/manager setup. */
export function resolveDeepSeekExecutable(env: DeepSeekEnvironment, platform = process.platform): string {
  const explicit = deepseekExecutableOverride(env, platform);
  if (explicit !== undefined) return explicit;
  if (platform !== "win32") return "dsh";

  const validRoot = (directory: string | undefined): string | undefined => {
    // A root-relative path (\foo) depends on the current drive; never turn an
    // invalid installation root into a working-directory discovery candidate.
    return directory && /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/.test(directory)
      && !/[\x00-\x1f\x7f]/.test(directory) ? directory : undefined;
  };
  const root = (key: "APPDATA" | "LOCALAPPDATA", suffix: string): string | undefined => {
    const configured = value(env, key, platform);
    if (configured !== undefined) return validRoot(configured);
    const profile = validRoot(value(env, "USERPROFILE", platform));
    return profile ? path.win32.join(profile, "AppData", suffix) : undefined;
  };
  const roaming = root("APPDATA", "Roaming");
  if (roaming) {
    const npm = resolveEngineExecutable(path.win32.join(roaming, "npm", "dsh.cmd"), env, platform);
    if (npm) return npm;
  }
  // A new Desktop install must not replace an already selected PATH command.
  const existing = resolveEngineExecutable("dsh", env, platform);
  // Consumers resolve the command when checking/starting it. Returning a
  // relative PATH result here would append its directory a second time.
  if (existing) return "dsh";
  const local = root("LOCALAPPDATA", "Local");
  if (local) {
    const desktop = resolveEngineExecutable(path.win32.join(local, "Programs", "DeepSeek Harness", "resources", "runtime", "cli", "bin", "dsh.cmd"), env, platform);
    if (desktop) return desktop;
  }
  return "dsh";
}
