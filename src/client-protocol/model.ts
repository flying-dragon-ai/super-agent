import { z } from "zod";
import { effortValueSchema } from "./effort.js";

// Provider IDs may contain '/', ':' or '[1m]', but never whitespace or controls.
export const modelValueSchema = z.string().trim().max(512).refine(value => !/[\s\p{Cc}]/u.test(value));
export const modelChoiceSchema = z.object({ id: z.string(), label: z.string().optional(),
  provider: z.string().optional(), modelId: z.string().optional(), efforts: z.array(effortValueSchema) }).strict();
export const modelSettingsSchema = z.object({
  scope: z.literal("bot"), revision: z.string().regex(/^[a-f0-9]{64}$/),
  engine: z.enum(["codex", "claude", "kimi", "deepseek", "antigravity", "pi"]),
  model: z.string(), effort: effortValueSchema, choices: z.array(modelChoiceSchema),
  customEfforts: z.array(effortValueSchema), activeTurns: z.number().int().nonnegative(),
  catalogStatus: z.enum(["ready", "no-models", "unavailable"]).optional(),
}).strict();
export const modelPatchSchema = z.object({ revision: modelSettingsSchema.shape.revision, model: modelValueSchema, effort: effortValueSchema.optional() }).strict();
export const modelErrorSchema = z.enum(["model_conflict", "model_effort_incompatible", "model_config_unreadable", "model_engine_changed", "model_id_invalid"]);
export const modelResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), settings: modelSettingsSchema }),
  z.object({ ok: z.literal(false), error: modelErrorSchema }),
]);
export type ModelSettings = z.infer<typeof modelSettingsSchema>;
export type ModelPatch = z.infer<typeof modelPatchSchema>;
