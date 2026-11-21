import { z } from "zod";
import { piSessionCommandSchema } from "./pi-commands.js";

/** Live conversation controls; these do not alter the Bot's defaults. */
export const PI_SESSION_CAPABILITY = "pi.session.v1";
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
export const piSessionThinkingSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
export const piSessionUiSchema = z.object({
  status: z.record(z.string().max(80), z.string().max(1000)).refine(value => Object.keys(value).length <= 20),
  widgets: z.record(z.string().max(80), z.object({ lines: z.array(z.string().max(1000)).max(20), placement: z.enum(["aboveEditor", "belowEditor"]) }).strict()).refine(value => Object.keys(value).length <= 10),
  title: z.string().max(200).optional(),
}).strict();
export const piSessionStateSchema = z.object({
  /** Opaque identity of this conversation's current live native worker, not a resumable session id. */
  token: id,
  model: z.string().min(1).max(512).optional(),
  modelSource: z.enum(["ticket", "session", "bot-default", "native"]),
  thinking: piSessionThinkingSchema,
  thinkingLevels: z.array(piSessionThinkingSchema).max(7),
  choices: z.array(z.object({ id: z.string().min(1).max(512), label: z.string().max(700), provider: z.string().max(512), modelId: z.string().max(512), efforts: z.array(z.union([z.literal(""), piSessionThinkingSchema])).max(8) }).strict()).max(5000),
  commands: z.array(piSessionCommandSchema).max(2000).optional(),
  busy: z.boolean(),
  bridge: z.enum(["connected", "unavailable"]),
  ui: piSessionUiSchema,
}).strict();
export const piSessionSnapshotSchema = z.object({ supported: z.boolean(), session: piSessionStateSchema.optional() }).strict();
export const piSessionChangeSchema = z.object({
  botId: id, requestId: id, expectedSession: id,
  action: z.enum(["model", "thinking"]), value: z.string().min(1).max(512).nullable(),
}).strict();
export const piSessionResultSchema = z.object({
  outcome: z.enum(["accepted", "rejected", "unknown"]),
  reason: z.enum(["unsupported", "stale", "not_ready", "invalid", "uncertain"]).optional(),
}).strict();
export type PiSessionState = z.infer<typeof piSessionStateSchema>;
export type PiSessionSnapshot = z.infer<typeof piSessionSnapshotSchema>;
export type PiSessionChange = z.infer<typeof piSessionChangeSchema>;
export type PiSessionResult = z.infer<typeof piSessionResultSchema>;
