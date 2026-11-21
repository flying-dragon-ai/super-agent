import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { encodePiModel, parsePiModels, type PiModelChoice } from "../codex/pi-models.js";
import { modelDiscoveryEnabled } from "./cli-model-discovery.js";
import { queryPiCatalog } from "../codex/pi-rpc-client.js";
import { resolvePiExecutable } from "./pi-executable.js";

export type PiModelCatalog = {
  status: "ready" | "no-models" | "unavailable";
  models: PiModelChoice[];
  defaultModel?: string;
};
const unavailable = (): PiModelCatalog => ({ status: "unavailable", models: [] });
const cache = new Map<string, { expires: number; promise: Promise<PiModelCatalog> }>();

/** Native metadata only: no prompt, model switch, credentials readback, or
 * session file. Workspace participates in both discovery and the cache key. */
export function discoverPiModels(env: NodeJS.ProcessEnv = process.env, cwd?: string): Promise<PiModelCatalog> {
  if (!modelDiscoveryEnabled(env)) return Promise.resolve(unavailable());
  const key = createHash("sha256").update(JSON.stringify([resolvePiExecutable(env), env, cwd])).digest("hex");
  const current = cache.get(key);
  if (current && current.expires > Date.now()) return current.promise;
  const entry = { expires: Number.POSITIVE_INFINITY, promise: Promise.resolve(unavailable()) };
  entry.promise = readPiCatalog(env, cwd).catch(unavailable).then(result => {
    // Share overlapping reads, but let an explicit reread see recent native login/config changes.
    entry.expires = Date.now() + 1000;
    return result;
  });
  if (cache.size >= 16) cache.delete(cache.keys().next().value!);
  cache.set(key, entry);
  return entry.promise;
}

async function readPiCatalog(env: NodeJS.ProcessEnv, cwd?: string): Promise<PiModelCatalog> {
  // Never treat a shared temporary directory as a trusted Pi project. mkdtemp
  // creates an owner-only empty directory; an explicit workspace stays native.
  const temporary = cwd ? undefined : await mkdtemp(path.join(os.tmpdir(), "open-super-agent-pi-catalog-"));
  try {
    const result = await queryPiCatalog({ launch: { command: resolvePiExecutable(env), args: [] }, cwd: cwd ?? temporary!, env, extraArgs: ["--no-mcp"] });
    const models = parsePiModels(result.models);
    const defaultModel = result.current ? encodePiModel(result.current.provider, result.current.modelId) : undefined;
    return { status: models.length ? "ready" : "no-models", models,
      ...(defaultModel && models.some(model => model.id === defaultModel) ? { defaultModel } : {}) };
  } finally { if (temporary) await removeCatalogDirectory(temporary); }
}

const REMOVE_RETRY_MS = 250;
/** Longer than the catalog process can take to end: its close escalates to a kill within about eight seconds. */
const REMOVE_RETRIES = 48;

/**
 * Remove the private directory a workspace-free read ran in. The catalog
 * process is closed in the background and may still be exiting; Windows does
 * not remove a directory that is some process's working directory (EBUSY,
 * EPERM). A removal that fails must not replace the catalog that was read, and
 * must not make its caller wait: it is tried again, for a bounded time, until
 * the process has gone.
 */
async function removeCatalogDirectory(directory: string): Promise<void> {
  const remove = () => rm(directory, { recursive: true, force: true }).then(() => true, () => false);
  if (await remove()) return;
  void (async () => {
    for (let attempt = 0; attempt < REMOVE_RETRIES; attempt++) {
      await new Promise<void>(resolve => { const timer = setTimeout(resolve, REMOVE_RETRY_MS); timer.unref?.(); });
      if (await remove()) return;
    }
  })();
}

export function resetPiModelDiscoveryForTest(): void { cache.clear(); }
