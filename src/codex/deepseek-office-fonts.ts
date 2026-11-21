import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { isAlias, isMap, isScalar, isSeq, parseDocument, visit, YAMLMap, YAMLSeq } from "yaml";

export const DEEPSEEK_OFFICE_TOOL_TIMEOUT_MS = 10 * 60_000;

/** Read the installed CLI's composed config without booting services or
 * evaluating loader expressions. Never include its output in diagnostics:
 * user profile settings can contain credentials. This is macOS-only at caller. */
export function readDeepSeekOfficeConfig(executable: string, home: string, cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(executable, ["--profile", "web", "--dump-config"], {
      cwd, env: { ...env, DSH_HOME: home }, timeout: 15_000,
      killSignal: "SIGKILL", maxBuffer: 2 * 1024 * 1024, encoding: "utf8",
    }, (error, stdout) => {
      // execFile errors can embed stdout/stderr (and hence user secrets).
      if (error) reject(new Error("DeepSeek Office config inspection was unavailable"));
      else resolve(stdout);
    });
  });
}

/** Explicit local roots disable Kit's implicit Microsoft Office cloud cache
 * discovery, which can block a worker in a macOS cross-App-data permission
 * request. Retain installed user fonts and downloaded macOS font assets. */
export async function macOfficeFontDirectories(): Promise<string[]> {
  const assets = "/System/Library/AssetsV2";
  const roots = ["/System/Library/Fonts", "/Library/Fonts", path.join(homedir(), "Library", "Fonts")];
  try {
    const entries = await readdir(assets, { withFileTypes: true });
    roots.push(...entries.filter(entry => /^com_apple_MobileAsset_Font\d*$/.test(entry.name))
      .map(entry => path.join(assets, entry.name)).sort());
  } catch (error) {
    if (!["ENOENT", "EACCES", "EPERM"].includes(String((error as NodeJS.ErrnoException).code))) throw error;
  }
  return roots;
}

/** Append a narrow override to the PRIVATE home, retaining the installed
 * profile's composed limits, output ownership and !!js nodes. The host never
 * evaluates YAML code. Custom roots, opaque configs and disabled providers are
 * user-owned; leave them alone rather than reconstructing their behavior. */
export function createDeepSeekOfficeFontPatch(source: string, roots: readonly string[]): string {
  const config = officeConfig(source);
  if (config === null) return "";
  if (isMap(config) && config.has("fontDirectories")) return "";
  const output = parseDocument("[]");
  const entry = new YAMLMap();
  entry.set("id", "office-kit");
  entry.set("name", "@deepseek-ai/dsh-office-kit");
  const patched: YAMLMap = isMap(config) ? config.clone() as YAMLMap : new YAMLMap();
  patched.set("fontDirectories", output.createNode([...roots]));
  entry.set("config", patched);
  const sequence = output.contents as YAMLSeq;
  sequence.flow = false;
  sequence.add(entry);
  return output.toString({ lineWidth: 0 });
}

function scalarValue(node: unknown): unknown {
  return isScalar(node) ? node.value : undefined;
}

/** Bound a normal Office call beyond the provider's configured conversion and
 * queue allowance. Opaque/custom providers retain their existing turn budget:
 * guessing a shorter deadline could cancel intentional long conversions. */
export function deepSeekOfficeToolTimeout(source: string): number | null {
  const config = officeConfig(source);
  if (config === null) return null;
  const values = [["timeoutMs", 60_000], ["maxQueuedJobs", 8], ["maxConcurrentConversions", 2]] as const;
  const resolved: number[] = [];
  for (const [key, fallback] of values) {
    const node = config?.get(key, true);
    if (node === undefined) { resolved.push(fallback); continue; }
    if (!isScalar(node) || node.tag || typeof node.value !== "number" || !Number.isSafeInteger(node.value) || node.value <= 0) return null;
    resolved.push(node.value);
  }
  const [conversion, queued, concurrent] = resolved as [number, number, number];
  const budget = Math.max(DEEPSEEK_OFFICE_TOOL_TIMEOUT_MS, 2 * conversion * (1 + Math.ceil(queued / concurrent)));
  // Avoid Node's overflow-to-one-millisecond timer behavior.
  return Number.isSafeInteger(budget) && budget <= 2_147_483_647 ? budget : null;
}

function officeConfig(source: string): YAMLMap | undefined | null {
  const document = parseDocument(source, { customTags: [{ tag: "tag:yaml.org,2002:js", resolve: (value: string) => value }] });
  if (document.errors.length || document.warnings.length || !isSeq(document.contents)) throw new Error("Invalid DeepSeek config inspection");
  const providers = document.contents.items.filter(item => isMap(item) && scalarValue(item.get("id", true)) === "office-kit");
  if (providers.length > 1) throw new Error("Ambiguous DeepSeek Office provider");
  const provider = providers[0];
  if (!isMap(provider) || scalarValue(provider.get("name", true)) !== "@deepseek-ai/dsh-office-kit") return null;
  const disabled = provider.get("disabled", true);
  if (disabled !== undefined && (!isScalar(disabled) || disabled.tag || scalarValue(disabled) !== false)) return null;
  const config = provider.get("config", true);
  if (config !== undefined && !isMap(config)) return null;
  // Merge keys/alias graphs may supply runtime values not visible as plain keys.
  let references = false;
  if (config) visit(config, (_key, node) => {
    if (isAlias(node) || isMap(node) && node.has("<<") || node && typeof node === "object" && "anchor" in node && node.anchor) references = true;
  });
  return references ? null : config as YAMLMap | undefined;
}
