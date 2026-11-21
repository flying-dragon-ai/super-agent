import { z } from "zod";
import { isOpenSuperAgentCoreSlashCommand } from "../core/slash-command-registry.js";

const piCommandNameSchema = z.string().min(1).max(128).regex(/^[^\s/\\\x00-\x1f\x7f]+$/);

export const piSessionCommandSchema = z.object({
  name: piCommandNameSchema,
  description: z.string().max(1000).optional(),
  source: z.enum(["extension", "prompt", "skill"]),
}).strict();
export type PiSessionCommand = z.infer<typeof piSessionCommandSchema>;

/** Commands the native adapter can handle during the current turn. */
export const PI_LIVE_COMMANDS: ReadonlySet<string> = new Set(["model", "thinking", "name", "session", "copy", "settings"]);
const reserved = new Set([
  "side", "tasks",
  "settings", "model", "tree", "thinking", "scoped-models", "export", "import", "share", "bug", "copy", "name", "session", "changelog", "hotkeys", "fork", "clone", "trust", "login", "logout", "new", "compact", "resume", "reload", "quit", "debug", "arminsayshi", "dementedelves",
]);

/** Only reviewed metadata crosses the client boundary, never source paths. */
export function piSessionCommands(raw: unknown[]): PiSessionCommand[] {
  const commands = new Map<string, PiSessionCommand>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    const parsed = piSessionCommandSchema.safeParse({ name: item.name, source: item.source,
      ...(typeof item.description === "string" ? { description: item.description.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 1000) } : {}),
    });
    if (parsed.success && !commands.has(parsed.data.name)) commands.set(parsed.data.name, parsed.data);
    if (commands.size >= 2000) break;
  }
  return [...commands.values()];
}

export function isPiSessionCommand(name: string): boolean {
  return piCommandNameSchema.safeParse(name).success && !isOpenSuperAgentCoreSlashCommand(`/${name}`) && !reserved.has(name);
}

/** Native extension dispatch is not awaitable in the public bridge API; keep it as an owned Host turn. */
export function isPiLiveCommand(text: string, commands: readonly PiSessionCommand[] = []): boolean {
  const input = text.trim();
  if (!input.startsWith("/")) return false;
  const space = input.indexOf(" "), name = input.slice(1, space < 0 ? undefined : space);
  return PI_LIVE_COMMANDS.has(name) || isPiSessionCommand(name) && commands.some(command => command.name === name && command.source !== "extension");
}
