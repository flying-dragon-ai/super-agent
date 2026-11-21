/** Pi identifies a model by both provider and model ID. Escape each identity
 * component, retaining readable model path separators and common suffixes. */
export function encodePiModel(provider: string, modelId: string): string {
  const encodedModel = encodeURIComponent(modelId).replace(/%2F/gi, "/").replace(/%3A/gi, ":").replace(/%5B/gi, "[").replace(/%5D/gi, "]");
  return `${encodeURIComponent(provider)}/${encodedModel}`;
}

export function decodePiModel(value: string): { provider: string; modelId: string } | undefined {
  const separator = value.indexOf("/");
  if (separator < 1 || separator === value.length - 1 || /[\s\p{Cc}]/u.test(value)) return;
  try {
    const provider = decodeURIComponent(value.slice(0, separator));
    const modelId = decodeURIComponent(value.slice(separator + 1));
    if (!provider || !modelId || /\p{Cc}/u.test(provider + modelId)) return;
    return { provider, modelId };
  } catch { return; }
}

export const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type PiThinkingLevel = typeof PI_THINKING_LEVELS[number];
type PiModel = { provider: string; id: string; name?: unknown; reasoning?: unknown; thinkingLevelMap?: Record<string, unknown> };

/** Mirrors Pi 1.5.2 getSupportedThinkingLevels. Reading metadata avoids
 * changing the session model just to discover its supported levels. */
export function piThinkingLevels(model: Pick<PiModel, "reasoning" | "thinkingLevelMap">): PiThinkingLevel[] {
  if (model.reasoning !== true) return ["off"];
  return PI_THINKING_LEVELS.filter(level => {
    const mapped = model.thinkingLevelMap?.[level];
    return mapped !== null && ((level !== "xhigh" && level !== "max") || mapped !== undefined);
  });
}

export type PiModelChoice = { id: string; label: string; provider: string; modelId: string; efforts: ("" | PiThinkingLevel)[] };
export function parsePiModels(rows: unknown): PiModelChoice[] {
  if (!Array.isArray(rows)) return [];
  const choices: PiModelChoice[] = [], seen = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const model = row as PiModel;
    if (typeof model.provider !== "string" || !model.provider || typeof model.id !== "string" || !model.id
      || /\p{Cc}/u.test(model.provider + model.id)) continue;
    let id: string;
    // An identity that is not well-formed text (half a surrogate pair) cannot be encoded. One such row
    // from a custom provider must not take the whole catalog with it.
    try { id = encodePiModel(model.provider, model.id); } catch { continue; }
    if (id.length > 512 || seen.has(id)) continue;
    const name = typeof model.name === "string" && model.name.trim() && !/\p{Cc}/u.test(model.name)
      ? model.name.trim().slice(0, 160) : model.id;
    seen.add(id);
    choices.push({ id, label: `${name} · ${model.provider}`, provider: model.provider, modelId: model.id,
      efforts: ["", ...piThinkingLevels(model)] });
  }
  const labels = new Map<string, number>();
  for (const choice of choices) labels.set(choice.label, (labels.get(choice.label) ?? 0) + 1);
  // Native catalogs can contain two distinct IDs with the same display name
  // on the same provider. Expose the ID only where the label is ambiguous.
  for (const choice of choices) if (labels.get(choice.label)! > 1) {
    const name = choice.label.slice(0, -(` · ${choice.provider}`).length);
    choice.label = `${name} (${choice.modelId}) · ${choice.provider}`;
  }
  return choices;
}
