import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { modelSettings } from "../src/runtime/model-settings.js";
import { effortSettings } from "../src/runtime/effort-settings.js";
import { discoverPiModels } from "../src/runtime/pi-model-discovery.js";
import { parsePiModels } from "../src/codex/pi-models.js";
vi.mock("../src/runtime/pi-model-discovery.js", () => ({ discoverPiModels: vi.fn() }));
let root: string;
const discovery = vi.mocked(discoverPiModels);
const models = parsePiModels([
  { provider: "one", id: "org/model:latest", name: "Same", reasoning: true, thinkingLevelMap: { xhigh: null, max: "max" } },
  { provider: "two", id: "org/model:latest", name: "Same", reasoning: false },
]);
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "open-super-agent-pi-model-"));
  discovery.mockReset().mockResolvedValue({ status: "ready", models, defaultModel: models[0]!.id });
  await writeFile(path.join(root, "config.json"), JSON.stringify({ engine: "pi", model: models[0]!.id, effort: "minimal", workspacePath: path.join(root, "workspace"), persona: "keep", custom: 1 }));
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const read = async () => { const r = await modelSettings(root, "pi", 0); if (!r.ok) throw new Error(r.error); return r.settings; };
it("saves the exact provider/model atomically, rejecting unsupported reasoning without partially switching", async () => {
  const before = await read(), bytes = await readFile(path.join(root, "config.json"), "utf8");
  expect(before).toMatchObject({ engine: "pi", catalogStatus: "ready", model: models[0]!.id, effort: "minimal" });
  expect(discovery).toHaveBeenCalledWith(process.env, path.join(root, "workspace"));
  expect(await modelSettings(root, "pi", 0, { revision: before.revision, model: models[1]!.id })).toEqual({ ok: false, error: "model_effort_incompatible" });
  expect(await readFile(path.join(root, "config.json"), "utf8")).toBe(bytes);
  expect(await modelSettings(root, "pi", 0, { revision: before.revision, model: models[1]!.id, effort: "off" })).toMatchObject({ ok: true, settings: { model: models[1]!.id, effort: "off" } });
  expect(JSON.parse(await readFile(path.join(root, "config.json"), "utf8"))).toMatchObject({ persona: "keep", custom: 1, model: models[1]!.id });
  expect(await effortSettings(root, "pi", 0)).toMatchObject({ ok: true, settings: { choices: ["", "off"] } });
  expect(await modelSettings(root, "pi", 0, { revision: before.revision, model: models[0]!.id })).toEqual({ ok: false, error: "model_conflict" });
});
it("requires provider identity, preserves unavailable saved selections and allows explicitly clearing back to native defaults", async () => {
  const before = await read();
  expect(await modelSettings(root, "pi", 0, { revision: before.revision, model: "bare-model", effort: "" })).toEqual({ ok: false, error: "model_id_invalid" });
  discovery.mockResolvedValue({ status: "unavailable", models: [] });
  const unavailable = await read(); expect(unavailable.choices.some(row => row.id === before.model)).toBe(true);
  expect(unavailable).toMatchObject({ model: before.model, effort: "minimal", catalogStatus: "unavailable" });
  expect(await modelSettings(root, "pi", 0, { revision: unavailable.revision, model: "", effort: "" })).toMatchObject({ ok: true, settings: { model: "", effort: "" } });
  const cleared = JSON.parse(await readFile(path.join(root, "config.json"), "utf8")); expect(cleared).not.toHaveProperty("model"); expect(cleared).not.toHaveProperty("effort");
});
it("rejects a catalog read for a workspace that changed before save", async () => {
  const before = await read();
  discovery.mockImplementationOnce(async () => {
    const file = path.join(root, "config.json"), cfg = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, JSON.stringify({ ...cfg, workspacePath: path.join(root, "other") }));
    return { status: "ready", models };
  });
  expect(await modelSettings(root, "pi", 0, { revision: before.revision, model: models[1]!.id, effort: "" })).toEqual({ ok: false, error: "model_conflict" });
});
