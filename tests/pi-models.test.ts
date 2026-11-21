import { describe, expect, it } from "vitest";
import { decodePiModel, encodePiModel, parsePiModels, piThinkingLevels } from "../src/codex/pi-models.js";
import { applyEngineSelection, getEngineEffortValidationError } from "../src/state/instance-config.js";
import { modelOptions, selectModel } from "../client/src/model-selection.js";
import { permissionOptions } from "../src/state/permission-options.js";

describe("Pi provider/model identity", () => {
  it("keeps same model IDs on different providers separate and preserves slashes", () => {
    const a = encodePiModel("provider/one%", "company/model:latest");
    expect(decodePiModel(a)).toEqual({ provider: "provider/one%", modelId: "company/model:latest" });
    expect(decodePiModel("openrouter/company/model")).toEqual({ provider: "openrouter", modelId: "company/model" });
    const choices = parsePiModels(["a", "b"].map(provider => ({ provider, id: "same", name: "Same" })));
    expect(choices.map(row => row.id)).toEqual(["a/same", "b/same"]);
    expect(choices.map(row => row.label)).toEqual(["Same · a", "Same · b"]);
  });
  it.each(["model", "/model", "provider/", "%invalid/model", "p/a\nb", "p%00/x"])("rejects ambiguous or malformed ID %j", value => {
    expect(decodePiModel(value)).toBeUndefined();
  });
  it("sanitizes native metadata without exposing endpoints, headers or keys", () => {
    const choices = parsePiModels([{ provider: "synthetic", id: "model", name: "Native model", headers: { Authorization: "fixture-only" }, baseUrl: "https://example.test", apiKey: "fixture-only", reasoning: false }]);
    expect(choices).toEqual([{ id: "synthetic/model", label: "Native model · synthetic", provider: "synthetic", modelId: "model", efforts: ["", "off"] }]);
  });
  it("distinguishes identical display names on the same provider by native model ID", () => {
    const choices = parsePiModels([
      { provider: "same", id: "model-one", name: "Shared" },
      { provider: "same", id: "model-two", name: "Shared" },
      { provider: "other", id: "model-one", name: "Shared" },
    ]);
    expect(choices.map(choice => choice.label)).toEqual(["Shared (model-one) · same", "Shared (model-two) · same", "Shared · other"]);
  });
  it("round-trips custom identity whitespace and literal percent signs without dropping the model", () => {
    const provider = "Local Provider", modelId = "org/model 20% /custom[1m] ";
    const models = parsePiModels([{ provider, id: modelId, name: "Custom" }]);
    expect(models).toHaveLength(1);
    expect(models[0]!.id).not.toMatch(/\s/);
    expect(decodePiModel(models[0]!.id)).toEqual({ provider, modelId });
    expect(decodePiModel(encodePiModel("p", "literal%20name"))?.modelId).toBe("literal%20name");
    expect(decodePiModel("p/model%0Aname")).toBeUndefined();
  });
  it("honors model-specific reasoning, including native off and minimal", () => {
    expect(piThinkingLevels({ reasoning: false })).toEqual(["off"]);
    expect(piThinkingLevels({ reasoning: true, thinkingLevelMap: { off: null, minimal: null, xhigh: "adaptive", max: null } })).toEqual(["low", "medium", "high", "xhigh"]);
    expect(piThinkingLevels({ reasoning: true })).toEqual(["off", "minimal", "low", "medium", "high"]);
    const choices = modelOptions("pi", parsePiModels([{ provider: "test", id: "reasoning", reasoning: true }, { provider: "test", id: "plain", reasoning: false }]));
    expect(choices[0]?.efforts).toContain("minimal");
    expect(selectModel(choices, "test/plain", { model: "test/reasoning", effort: "high" })).toEqual({ model: "test/plain", effort: "" });
  });
  it("does not widen another engine's accepted effort levels", () => {
    for (const engine of ["codex", "claude", "kimi", "deepseek", "antigravity"] as const) {
      expect(getEngineEffortValidationError(engine, "off")).toBeTruthy();
      expect(getEngineEffortValidationError(engine, "minimal")).toBeTruthy();
    }
    expect(getEngineEffortValidationError("pi", "off")).toBeUndefined();
    expect(getEngineEffortValidationError("pi", "ultra")).toBeTruthy();
  });
  it("starts with native defaults, preserving an existing Pi selection", () => {
    const config: Record<string, unknown> = { engine: "codex", model: "codex-model", effort: "xhigh", approvalMode: "full-auto" };
    applyEngineSelection(config, "pi");
    expect(config).toMatchObject({ engine: "pi", approvalMode: "normal" });
    expect(config.model).toBeUndefined(); expect(config.effort).toBeUndefined();
    Object.assign(config, { model: "provider/model", effort: "minimal" });
    applyEngineSelection(config, "pi");
    expect(config).toMatchObject({ model: "provider/model", effort: "minimal" });
    expect(permissionOptions("pi").map(option => option.id)).toEqual(["bypass", "normal"]);
  });
});
