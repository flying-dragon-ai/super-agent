import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runPiNativeCommand, type PiCommandAnswer, type PiCommandQuestion, type PiNativeCommandContext } from "../src/codex/pi-native-commands.js";
import type { PiNativeControls, PiNativeTree, PiNativeTreeNode } from "../src/codex/pi-native-types.js";
import { decodePiModel, encodePiModel, parsePiModels } from "../src/codex/pi-models.js";

/** Scripted controls: only what a case names exists; anything else would be a call the case did not expect. */
function context(controls: Partial<PiNativeControls>, extra: Partial<PiNativeCommandContext> = {}): PiNativeCommandContext {
  const base = new Proxy(controls as PiNativeControls, { get: (target, key) => (target as never)[key] ?? (async () => { throw new Error(`unscripted control ${String(key)}`); }) });
  return { sessionId: "s1", controls: base, locale: "en", approvalMode: "bypass", ...extra };
}
const reply = async (text: string, ctx: PiNativeCommandContext): Promise<string> => { const result = await runPiNativeCommand(text, ctx); return result.handled ? result.text : "NOT HANDLED"; };

describe("/scoped-models over a long catalog", () => {
  const rows = Array.from({ length: 40 }, (_unused, index) => ({ provider: `prov${index % 2}`, id: `model-${index}`, name: `Model ${index}`, reasoning: false }));
  const controls = (saved: unknown[]): Partial<PiNativeControls> => ({
    getModelScope: async () => ({ scope: [], nativePatterns: [] }), listModels: async () => rows as never, listCommands: async () => [],
    setModelScope: async (_id, models) => { saved.push(models); return { scope: models ?? [], nativePatterns: [] }; },
  });

  it("changes nothing when the owner never chooses Save, however many rounds that takes", async () => {
    const saved: unknown[] = [];
    let cards = 0;
    // Always a provider, then its first model; never the Save row.
    const ask = async (question: PiCommandQuestion): Promise<PiCommandAnswer> => {
      cards++;
      const provider = question.options.find(option => option.value.startsWith("provider:"));
      return provider ? { value: provider.value } : { values: [question.options[0]!.value] };
    };
    const text = await reply("/scoped-models", context(controls(saved), { ask }));
    expect(cards).toBeGreaterThan(10);
    expect(saved).toEqual([]);
    expect(text).not.toMatch(/scope is now/i);
    expect(text).toMatch(/not saved|nothing was saved/i);
  });

  it("still saves what was selected once the owner chooses Save", async () => {
    const saved: unknown[] = [];
    let step = 0;
    const ask = async (question: PiCommandQuestion): Promise<PiCommandAnswer> => {
      step++;
      if (step === 1) return { value: question.options.find(option => option.value.startsWith("provider:"))!.value };
      if (step === 2) return { values: [question.options[0]!.value] };
      return { value: question.options[0]!.value }; // the Save row is first once something is selected
    };
    const text = await reply("/scoped-models", context(controls(saved), { ask }));
    expect(saved).toEqual([[{ provider: "prov0", modelId: "model-0" }]]);
    expect(text).toMatch(/scope is now/i);
  });
});

describe("a model catalog with a row that cannot be encoded", () => {
  it("drops that row and keeps the rest", () => {
    expect(parsePiModels([{ provider: "p", id: "ok" }, { provider: "p", id: "bad\ud800" }, { provider: "q\udc00", id: "x" }, { provider: "p", id: "also-ok" }]).map(choice => choice.id)).toEqual(["p/ok", "p/also-ok"]);
  });
  it("round-trips every identity it does list", () => {
    for (const [provider, modelId] of [["a/b", "c"], ["a", "b/c"], ["p", "m:free"], ["p", "sp ace"], ["p", "100%"], ["p", "a%2Fb"], ["p", "模型"], ["p", "x[1m]"], ["p q", "y"], ["p", "a?b#c"], ["p", "😀-model"]] as const) {
      const [choice] = parsePiModels([{ provider, id: modelId }]);
      expect(choice?.id).toBe(encodePiModel(provider, modelId));
      expect(decodePiModel(choice!.id)).toEqual({ provider, modelId });
    }
  });
});

describe("names cut to length", () => {
  const roots: string[] = [];
  afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

  it.each([45, 80])("keep an export file name whole and creatable for %i characters outside the basic plane", async count => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "pi-export-name-"));
    roots.push(outputDir);
    // The control really creates the file: a name the file system refuses would fail here.
    const asked: string[] = [];
    const ctx = context({ exportHtml: async (_id, input) => { asked.push(input!.outputPath!); await writeFile(input!.outputPath!, "<html></html>"); return { path: input!.outputPath! }; }, listCommands: async () => [] }, { outputDir });
    const text = await reply(`/export a${"\u{20000}".repeat(count)}.html`, ctx);
    expect(text).toMatch(/^Session exported to /);
    // Half a surrogate pair in the name the adapter chose: the file system would quietly replace it, and
    // the reply would name a file that does not exist under that name.
    expect(asked.map(file => file.isWellFormed())).toEqual([true]);
    expect(text.isWellFormed()).toBe(true);
    const [name] = await readdir(outputDir);
    expect(name).toBe(path.basename(asked[0]!));
    expect(name!.endsWith(".html")).toBe(true);
    // The old budget still holds: 80 UTF-16 units of name, so well inside one path component.
    expect(name!.length).toBeLessThanOrEqual(80 + ".html".length);
    expect(Buffer.byteLength(name!)).toBeLessThanOrEqual(255);
  });
});

// ---------------------------------------------------------------------------
// /tree
// ---------------------------------------------------------------------------

const node = (id: string, parentId: string | null, childIds: string[], extra: Partial<PiNativeTreeNode> = {}): PiNativeTreeNode =>
  ({ id, parentId, type: "message", role: "user", preview: `entry ${id}`, childIds, ...extra });

/** The listing's depth and branch mark for each entry, as the command computed them before it shared any work between entries. */
function reference(tree: PiNativeTree): Map<string, { depth: number; mark: string }> {
  const out = new Map<string, { depth: number; mark: string }>();
  for (const entry of tree.nodes) {
    const byId = new Map(tree.nodes.map(item => [item.id, item]));
    const onPath = new Set<string>();
    for (let cursor = tree.leafId ? byId.get(tree.leafId) : undefined, guard = 0; cursor && guard <= tree.nodes.length; guard++) { onPath.add(cursor.id); cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined; }
    let depth = 0;
    for (let cursor = entry.parentId ? byId.get(entry.parentId) : undefined, guard = 0; cursor && guard <= tree.nodes.length; guard++) { if (cursor.childIds.length > 1) depth++; cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined; }
    out.set(entry.id, { depth: Math.min(depth, 6), mark: entry.id === tree.leafId ? "current position" : onPath.has(entry.id) ? "current branch" : "other branch" });
  }
  return out;
}

/** Every entry on its own line, in the listing's order: `N. · · entry <id> (<mark>)`. */
async function listed(tree: PiNativeTree): Promise<Array<{ id: string; depth: number; mark: string }>> {
  const text = await reply("/tree", context({ getTree: async () => tree, listCommands: async () => [] }, { readNativeSettings: async () => ({ treeFilterMode: "all" }) }));
  return text.split("\n").map(line => /^\d+\. ((?:· )*)entry (\S+) \((.*)\)$/.exec(line)).filter((match): match is RegExpExecArray => Boolean(match))
    .map(match => ({ id: match[2]!, depth: match[1]!.length / 2, mark: match[3]!.split(" · ").at(-1)! }));
}

function randomTree(seed: number, size: number, malformed: boolean): PiNativeTree {
  let state = seed;
  const next = (bound: number) => { state = (state * 1103515245 + 12345) & 0x7fffffff; return state % bound; };
  const nodes: PiNativeTreeNode[] = [];
  for (let index = 0; index < size; index++) nodes.push(node(`n${index}`, index === 0 ? null : `n${next(index)}`, []));
  for (const entry of nodes) if (entry.parentId) nodes.find(candidate => candidate.id === entry.parentId)!.childIds.push(entry.id);
  if (malformed) {
    // Data Pi would not produce: a parent cycle, a parent that does not exist, an id used twice.
    const a = nodes[1 + next(size - 1)]!, b = nodes[1 + next(size - 1)]!;
    a.parentId = b.id; b.parentId = a.id;
    nodes[1 + next(size - 1)]!.parentId = "missing";
    if (next(2)) nodes.push(node(nodes[next(size)]!.id, `n${next(size)}`, [`n${next(size)}`, `n${next(size)}`]));
  }
  return { nodes, leafId: nodes[next(nodes.length)]!.id };
}

describe("/tree listing", () => {
  it("marks and indents every entry exactly as before, for well-formed and malformed trees alike", async () => {
    for (let seed = 1; seed <= 300; seed++) {
      const tree = randomTree(seed, 4 + (seed % 26), seed % 3 === 0);
      const want = reference(tree);
      const got = await listed(tree);
      // Newest first; an id used twice is listed twice and both lines must agree with the reference for that id.
      expect(got.map(item => item.id), `seed ${seed}`).toEqual([...tree.nodes].reverse().map(entry => entry.id));
      for (const item of got) expect({ seed, ...item }).toEqual({ seed, id: item.id, ...want.get(item.id)! });
    }
  });

  it("reads the tree's links a bounded number of times per entry, not once per pair of entries", async () => {
    // Counted, not timed: the listing used to rebuild its index and walk to the root for every entry.
    const count = 3_000;
    let reads = 0;
    const counted = (entry: PiNativeTreeNode): PiNativeTreeNode => new Proxy(entry, { get: (target, key, receiver) => { if (key === "id" || key === "parentId" || key === "childIds") reads++; return Reflect.get(target, key, receiver); } });
    const tree: PiNativeTree = {
      nodes: Array.from({ length: count }, (_unused, index) => counted(node(`e${index}`, index ? `e${index - 1}` : null, index + 1 < count ? [`e${index + 1}`] : []))), leafId: `e${count - 1}`,
    };
    const text = await reply("/tree", context({ getTree: async () => tree, listCommands: async () => [] }));
    expect(text).toContain("entry e2999");
    expect(reads).toBeGreaterThan(count);
    expect(reads).toBeLessThanOrEqual(64 * count);
  });

  it("reaches an entry by its exact id with the same mark, listed or not", async () => {
    const tree: PiNativeTree = { nodes: [node("a", null, ["b", "c"]), node("b", "a", []), node("c", "a", ["d"]), node("d", "c", [])], leafId: "d" };
    const moved: string[] = [];
    const ctx = context({ getTree: async () => tree, listCommands: async () => [], navigateTree: async (_id, input) => { moved.push(input.targetId); return { cancelled: false, leafId: input.targetId }; } });
    expect(await reply("/tree b", ctx)).toMatch(/Moved to the selected point/);
    expect(await reply("/tree d", ctx)).not.toMatch(/Moved to the selected point/);
    expect(moved).toEqual(["b"]);
  });
});
