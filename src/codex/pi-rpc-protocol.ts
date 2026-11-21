import { StringDecoder } from "node:string_decoder";
import { stripVTControlCharacters } from "node:util";
import { redactSecrets } from "../runtime/secret-redaction.js";
import type { PiThinkingLevel } from "./pi-models.js";

/**
 * Wire protocol of `pi --mode rpc`, verified against Pi 1.5.2 (rpc-types.ts and
 * recorded frames). Records are strict LF-delimited JSON; U+2028/U+2029 are
 * valid inside strings and never split a record. Parsing is tolerant: unknown
 * fields and unknown event types pass through so a newer Pi does not break us.
 */

export type { PiThinkingLevel } from "./pi-models.js";

export interface PiImageContent { type: "image"; data: string; mimeType: string }
export interface PiTextContent { type: "text"; text: string }
export interface PiThinkingContent { type: "thinking"; thinking: string; redacted?: boolean }
export interface PiToolCall { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
export type PiContentBlock = PiTextContent | PiImageContent | PiThinkingContent | PiToolCall | { type: string; [key: string]: unknown };

export interface PiUsage {
  input: number; output: number; cacheRead: number; cacheWrite: number;
  reasoning?: number; totalTokens: number;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number; totalFromProvider?: boolean };
}

export type PiStopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted";

export interface PiAssistantMessage {
  role: "assistant"; content: PiContentBlock[];
  provider?: string; model?: string; api?: string; usage?: PiUsage;
  stopReason?: PiStopReason | (string & {}); rawStopReason?: string; errorMessage?: string;
  durationMs?: number; thinkingLevel?: string; responseId?: string; timestamp?: number;
}
export interface PiToolResultMessage {
  role: "toolResult"; toolCallId: string; toolName: string; content: PiContentBlock[];
  isError?: boolean; durationMs?: number; timestamp?: number;
}
export interface PiUserMessage { role: "user"; content: string | PiContentBlock[]; timestamp?: number }
/** system, bashExecution, custom, branchSummary, compactionSummary and future roles. */
export interface PiOtherMessage { role: string; content?: unknown; [key: string]: unknown }
export type PiMessage = PiAssistantMessage | PiToolResultMessage | PiUserMessage | PiOtherMessage;

export interface PiModel {
  id: string; name: string; provider: string; api?: string;
  reasoning: boolean; input: string[]; contextWindow: number; maxTokens: number;
  thinkingLevelMap?: Record<string, unknown>;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}
export interface PiModelRef { provider: string; modelId: string }

export type PiQueueMode = "all" | "one-at-a-time";
export interface PiSessionState {
  model?: PiModel; thinkingLevel: PiThinkingLevel;
  isStreaming: boolean; isCompacting: boolean;
  steeringMode: PiQueueMode; followUpMode: PiQueueMode;
  sessionFile?: string; sessionId: string; sessionName?: string;
  autoCompactionEnabled: boolean; messageCount: number; pendingMessageCount: number;
}

export interface PiSessionEntry { type: string; id: string; parentId: string | null; timestamp?: string; message?: PiMessage; [key: string]: unknown }
export interface PiSessionTreeNode { entry: PiSessionEntry; children: PiSessionTreeNode[]; label?: string; labelTimestamp?: string }

export interface PiSessionStats {
  sessionFile?: string; sessionId: string;
  userMessages: number; assistantMessages: number; toolCalls: number; toolResults: number; totalMessages: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  cost: number;
  contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
}

export interface PiCompactionResult {
  summary: string; firstKeptEntryId?: string; tokensBefore?: number; estimatedTokensAfter?: number;
  usage?: PiUsage; details?: unknown;
}
export interface PiBashResult { output: string; exitCode?: number | null; cancelled: boolean; truncated: boolean; fullOutputPath?: string }
export interface PiSlashCommand {
  name: string; description?: string; source: "extension" | "prompt" | "skill" | (string & {});
  sourceInfo?: { path?: string; source?: string; scope?: string; origin?: string; baseDir?: string };
}

export type PiCommand =
  | { type: "prompt"; message: string; images?: PiImageContent[]; streamingBehavior?: "steer" | "followUp" }
  | { type: "steer"; message: string; images?: PiImageContent[] }
  | { type: "follow_up"; message: string; images?: PiImageContent[] }
  | { type: "abort" }
  | { type: "clear_queue" }
  | { type: "new_session"; parentSession?: string }
  | { type: "get_state" }
  | { type: "set_model"; provider: string; modelId: string }
  | { type: "cycle_model" }
  | { type: "get_available_models" }
  | { type: "set_thinking_level"; level: PiThinkingLevel }
  | { type: "cycle_thinking_level" }
  | { type: "get_available_thinking_levels" }
  | { type: "set_steering_mode"; mode: PiQueueMode }
  | { type: "set_follow_up_mode"; mode: PiQueueMode }
  | { type: "compact"; customInstructions?: string }
  | { type: "set_auto_compaction"; enabled: boolean }
  | { type: "set_auto_retry"; enabled: boolean }
  | { type: "abort_retry" }
  | { type: "bash"; command: string; excludeFromContext?: boolean }
  | { type: "abort_bash" }
  | { type: "get_session_stats" }
  | { type: "export_html"; outputPath?: string }
  | { type: "switch_session"; sessionPath: string }
  | { type: "fork"; entryId: string }
  | { type: "clone" }
  | { type: "get_fork_messages" }
  | { type: "get_entries"; since?: string }
  | { type: "get_tree" }
  | { type: "get_last_assistant_text" }
  | { type: "set_session_name"; name: string }
  | { type: "get_messages" }
  | { type: "get_commands" };
export type PiCommandType = PiCommand["type"];

export type PiPromptDisposition = "handled" | "queued" | "started";
export interface PiResponseDataMap {
  prompt: { disposition: PiPromptDisposition };
  steer: { disposition: "handled" | "queued" };
  follow_up: { disposition: "handled" | "queued" };
  abort: undefined;
  clear_queue: { steering: string[]; followUp: string[] };
  new_session: { cancelled: boolean };
  get_state: PiSessionState;
  set_model: PiModel;
  cycle_model: { model: PiModel; thinkingLevel: PiThinkingLevel; isScoped: boolean } | null;
  get_available_models: { models: PiModel[] };
  set_thinking_level: undefined;
  cycle_thinking_level: { level: PiThinkingLevel } | null;
  get_available_thinking_levels: { levels: PiThinkingLevel[] };
  set_steering_mode: undefined;
  set_follow_up_mode: undefined;
  compact: PiCompactionResult;
  set_auto_compaction: undefined;
  set_auto_retry: undefined;
  abort_retry: undefined;
  bash: PiBashResult;
  abort_bash: undefined;
  get_session_stats: PiSessionStats;
  export_html: { path: string };
  switch_session: { cancelled: boolean };
  fork: { text?: string; cancelled: boolean };
  clone: { cancelled: boolean };
  get_fork_messages: { messages: Array<{ entryId: string; text: string }> };
  get_entries: { entries: PiSessionEntry[]; leafId: string | null };
  get_tree: { tree: PiSessionTreeNode[]; leafId: string | null };
  /** Pi 1.5.2 omits `text` (rather than sending null) when there is none. */
  get_last_assistant_text: { text?: string | null };
  set_session_name: undefined;
  get_messages: { messages: PiMessage[] };
  get_commands: { commands: PiSlashCommand[] };
}
export type PiResponseData<T extends PiCommandType> = PiResponseDataMap[T];

export interface PiResponseFrame { type: "response"; id?: string; command: string; success: boolean; data?: unknown; error?: string }

export type PiAssistantMessageEvent =
  | { type: "start" }
  | { type: "text_start" | "thinking_start"; contentIndex: number }
  | { type: "text_delta" | "thinking_delta" | "toolcall_delta"; contentIndex: number; delta: string }
  | { type: "text_end" | "thinking_end"; contentIndex: number; content: string }
  | { type: "toolcall_start"; contentIndex: number; id: string; toolName: string }
  | { type: "toolcall_end"; contentIndex: number; toolCall: PiToolCall }
  | { type: "done"; reason?: string; message?: PiAssistantMessage }
  | { type: "error"; reason?: string; error?: unknown };

export type PiCompactionReason = "manual" | "threshold" | "overflow";
export type PiSessionEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: PiMessage[]; willRetry: boolean }
  | { type: "agent_settled"; aborted: boolean }
  | { type: "turn_start" }
  | { type: "turn_end"; message: PiMessage; toolResults: PiToolResultMessage[] }
  | { type: "message_start" | "message_end"; message: PiMessage }
  | { type: "message_update"; usage?: PiUsage; assistantMessageEvent: PiAssistantMessageEvent }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown; parentToolCallId?: string }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: unknown; partialResult: unknown; parentToolCallId?: string }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean; durationMs?: number; parentToolCallId?: string }
  | { type: "queue_update"; steering: string[]; followUp: string[] }
  | { type: "entry_appended"; entry: PiSessionEntry }
  | { type: "session_info_changed"; name?: string }
  | { type: "thinking_level_changed"; level: PiThinkingLevel }
  | { type: "compaction_start"; reason: PiCompactionReason }
  | { type: "compaction_end"; reason: PiCompactionReason; result?: PiCompactionResult; aborted: boolean; willRetry: boolean; errorMessage?: string }
  | { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
  | { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
  | { type: "summarization_retry_scheduled"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
  | { type: "summarization_retry_attempt_start"; source: "compaction" | "branchSummary"; reason?: PiCompactionReason }
  | { type: "summarization_retry_finished" }
  | { type: "bash_execution_update"; id?: string; delta: string }
  | { type: "extension_error"; extensionPath: string; event: string; error: string }
  | PiUnknownEvent;
/** An event type this build does not know. Kept so callers can log or ignore it. */
export interface PiUnknownEvent { type: "unknown"; originalType: string; raw: Record<string, unknown> }

export type PiExtensionUiRequest =
  | { type: "extension_ui_request"; id: string; method: "select"; title: string; options: string[]; timeout?: number }
  | { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message: string; timeout?: number }
  | { type: "extension_ui_request"; id: string; method: "input"; title: string; placeholder?: string; timeout?: number }
  | { type: "extension_ui_request"; id: string; method: "editor"; title: string; prefill?: string }
  | { type: "extension_ui_request"; id: string; method: "notify"; message: string; notifyType?: "info" | "warning" | "error" }
  | { type: "extension_ui_request"; id: string; method: "setStatus"; statusKey: string; statusText?: string }
  | { type: "extension_ui_request"; id: string; method: "setWidget"; widgetKey: string; widgetLines?: string[]; widgetPlacement?: "aboveEditor" | "belowEditor" }
  | { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
  | { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string };
export type PiExtensionUiDialogMethod = "select" | "confirm" | "input" | "editor";
export type PiExtensionUiResponse =
  | { type: "extension_ui_response"; id: string; value: string }
  | { type: "extension_ui_response"; id: string; confirmed: boolean }
  | { type: "extension_ui_response"; id: string; cancelled: true };

export type PiFrame =
  | { kind: "response"; response: PiResponseFrame }
  | { kind: "event"; event: PiSessionEvent }
  | { kind: "extension_ui"; request: PiExtensionUiRequest }
  | { kind: "invalid"; reason: "json" | "shape" };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string";
const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every(isString);
const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isMessage = (value: unknown): value is PiMessage => isRecord(value) && isString(value.role);
const optional = <T>(value: unknown, check: (value: unknown) => value is T): boolean => value === undefined || value === null || check(value);

const KNOWN_EVENTS: Record<string, (frame: Record<string, unknown>) => boolean> = {
  agent_start: () => true,
  agent_end: f => Array.isArray(f.messages) && isBoolean(f.willRetry),
  agent_settled: f => isBoolean(f.aborted),
  turn_start: () => true,
  turn_end: f => isMessage(f.message) && Array.isArray(f.toolResults),
  message_start: f => isMessage(f.message),
  message_end: f => isMessage(f.message),
  message_update: f => isRecord(f.assistantMessageEvent) && isString(f.assistantMessageEvent.type),
  tool_execution_start: f => isString(f.toolCallId) && isString(f.toolName),
  tool_execution_update: f => isString(f.toolCallId) && isString(f.toolName),
  tool_execution_end: f => isString(f.toolCallId) && isString(f.toolName) && isBoolean(f.isError),
  queue_update: f => isStringArray(f.steering) && isStringArray(f.followUp),
  entry_appended: f => isRecord(f.entry) && isString(f.entry.type),
  session_info_changed: f => optional(f.name, isString),
  thinking_level_changed: f => isString(f.level),
  compaction_start: f => isString(f.reason),
  compaction_end: f => isString(f.reason) && isBoolean(f.aborted) && isBoolean(f.willRetry),
  auto_retry_start: f => isNumber(f.attempt) && isNumber(f.maxAttempts) && isNumber(f.delayMs) && isString(f.errorMessage),
  auto_retry_end: f => isBoolean(f.success) && isNumber(f.attempt),
  summarization_retry_scheduled: f => isNumber(f.attempt) && isNumber(f.maxAttempts) && isNumber(f.delayMs),
  summarization_retry_attempt_start: f => isString(f.source),
  summarization_retry_finished: () => true,
  bash_execution_update: f => isString(f.delta),
  extension_error: f => isString(f.extensionPath) && isString(f.event) && isString(f.error),
};

function narrowExtensionUi(frame: Record<string, unknown>): PiExtensionUiRequest | undefined {
  if (!isString(frame.id) || !frame.id || !isString(frame.method)) return;
  const timeoutOk = optional(frame.timeout, isNumber);
  switch (frame.method) {
    case "select": return isString(frame.title) && isStringArray(frame.options) && timeoutOk ? frame as PiExtensionUiRequest : undefined;
    case "confirm": return isString(frame.title) && isString(frame.message ?? "") && timeoutOk ? { ...frame, message: frame.message ?? "" } as PiExtensionUiRequest : undefined;
    case "input": return isString(frame.title) && optional(frame.placeholder, isString) && timeoutOk ? frame as PiExtensionUiRequest : undefined;
    case "editor": return isString(frame.title) && optional(frame.prefill, isString) ? frame as PiExtensionUiRequest : undefined;
    case "notify": return isString(frame.message) ? frame as PiExtensionUiRequest : undefined;
    case "setStatus": return isString(frame.statusKey) && optional(frame.statusText, isString) ? frame as PiExtensionUiRequest : undefined;
    case "setWidget": return isString(frame.widgetKey) && optional(frame.widgetLines, isStringArray) ? frame as PiExtensionUiRequest : undefined;
    case "setTitle": return isString(frame.title) ? frame as PiExtensionUiRequest : undefined;
    case "set_editor_text": return isString(frame.text) ? frame as PiExtensionUiRequest : undefined;
    default: return;
  }
}

/** Classify one stdout record. Never throws. */
export function parsePiFrame(line: string): PiFrame {
  let parsed: unknown;
  try { parsed = JSON.parse(line); } catch { return { kind: "invalid", reason: "json" }; }
  if (!isRecord(parsed) || !isString(parsed.type)) return { kind: "invalid", reason: "shape" };
  if (parsed.type === "response") {
    if (!isString(parsed.command) || !isBoolean(parsed.success) || !optional(parsed.id, isString) || !optional(parsed.error, isString)) return { kind: "invalid", reason: "shape" };
    return { kind: "response", response: parsed as unknown as PiResponseFrame };
  }
  if (parsed.type === "extension_ui_request") {
    const request = narrowExtensionUi(parsed);
    return request ? { kind: "extension_ui", request } : { kind: "invalid", reason: "shape" };
  }
  // Own keys only: `{"type":"constructor"}` must not resolve to an inherited member.
  const check = Object.hasOwn(KNOWN_EVENTS, parsed.type) ? KNOWN_EVENTS[parsed.type] : undefined;
  if (!check) return { kind: "event", event: { type: "unknown", originalType: parsed.type, raw: parsed } };
  return check(parsed) ? { kind: "event", event: parsed as unknown as PiSessionEvent } : { kind: "invalid", reason: "shape" };
}

export class PiFrameTooLargeError extends Error {
  constructor(readonly limitBytes: number) { super(`Pi RPC record exceeds ${limitBytes} bytes`); this.name = "PiFrameTooLargeError"; }
}

/** `get_messages` and `get_entries` return whole transcripts, inline images included. */
export const PI_MAX_FRAME_BYTES = 256 * 1024 * 1024;

/** Strict LF framing over a byte stream; a trailing CR is stripped. */
export class PiJsonlDecoder {
  private readonly decoder = new StringDecoder("utf8");
  private fragments: string[] = [];
  private frameBytes = 0;
  constructor(private readonly maxFrameBytes = PI_MAX_FRAME_BYTES) {}
  push(chunk: Buffer | string): string[] {
    const text = typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    const lines: string[] = [];
    let start = 0;
    // Scan only new text and join once per record. Repeatedly concatenating and
    // searching a growing transcript makes fragmented large records quadratic.
    for (let end = text.indexOf("\n", start); end >= 0; end = text.indexOf("\n", start)) {
      let line = text.slice(start, end);
      // UTF-8 uses at most three bytes per UTF-16 code unit. Ordinary small
      // complete events need no extra byte-count scan or fragment allocation.
      if (this.fragments.length) {
        this.append(line);
        line = this.take();
      } else if (line.length * 3 > this.maxFrameBytes && Buffer.byteLength(line, "utf8") > this.maxFrameBytes) {
        throw new PiFrameTooLargeError(this.maxFrameBytes);
      }
      const record = line.endsWith("\r") ? line.slice(0, -1) : line;
      if (record.length) lines.push(record);
      start = end + 1;
    }
    this.append(text.slice(start));
    return lines;
  }
  /** Flush a final unterminated record at end of stream. */
  end(): string[] {
    this.append(this.decoder.end());
    const rest = this.take();
    return rest.length ? [rest.endsWith("\r") ? rest.slice(0, -1) : rest] : [];
  }

  private append(text: string): void {
    if (!text) return;
    this.frameBytes += Buffer.byteLength(text, "utf8");
    // Buffer chunks go through StringDecoder. String callers can instead split
    // a surrogate pair: two standalone replacements (3 + 3) become 4 bytes.
    const previous = this.fragments.at(-1);
    const last = previous?.charCodeAt(previous.length - 1), first = text.charCodeAt(0);
    if (last !== undefined && last >= 0xd800 && last <= 0xdbff && first >= 0xdc00 && first <= 0xdfff) this.frameBytes -= 2;
    if (this.frameBytes > this.maxFrameBytes) {
      this.fragments = [];
      this.frameBytes = 0;
      throw new PiFrameTooLargeError(this.maxFrameBytes);
    }
    this.fragments.push(text);
  }

  private take(): string {
    const text = this.fragments.join("");
    this.fragments = [];
    this.frameBytes = 0;
    return text;
  }
}

/**
 * Cut to at most `units` UTF-16 code units without ending inside a surrogate
 * pair. Lengths here are budgets in code units (file names, RPC fields);
 * counting characters instead would let a name of astral characters grow to
 * twice the units and four bytes each.
 */
export function piClip(value: string, units: number): string {
  if (value.length <= units) return value;
  const cut = value.slice(0, units), last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

export function encodePiRecord(record: object): string {
  return `${JSON.stringify(record)}\n`;
}

/** With no usable model Pi 1.5.2 reports a placeholder object instead of omitting the field. */
export function isPiPlaceholderModel(model: unknown): boolean {
  return !isRecord(model) || !isString(model.provider) || !isString(model.id) || !model.provider || !model.id
    || (model.provider === "unknown" && model.id === "unknown");
}

export function toPiModelRef(model: unknown): PiModelRef | undefined {
  if (isPiPlaceholderModel(model)) return;
  const { provider, id } = model as PiModel;
  return { provider, modelId: id };
}

export const samePiModel = (a: PiModelRef | undefined, b: PiModelRef | undefined): boolean =>
  Boolean(a && b) && a!.provider === b!.provider && a!.modelId === b!.modelId;

export type PiErrorKind = "no-model" | "auth" | "model-unavailable" | "busy" | "compacting" | "other";

/** Pi reuses "Model not found" for an unknown model and for a provider without credentials. */
export function classifyPiError(message: string): PiErrorKind {
  // "No API key found for the selected model" is the no-model case; with a provider or model named it is that provider's sign-in.
  if (/^No API key found for the selected model|No models? available|No model selected/i.test(message)) return "no-model";
  if (/Authentication failed for|No API key (?:found )?for /i.test(message)) return "auth";
  if (/^Model not found: /i.test(message)) return "model-unavailable";
  if (/already processing/i.test(message)) return "busy";
  if (/compaction is in progress/i.test(message)) return "compacting";
  return "other";
}

/** Plain App presentation of terminal-styled extension output. Keep ordinary
 * text, paths, tabs/newlines and emoji joiners; remove terminal and bidi controls. */
export function piDisplayText(message: string): string {
  return stripVTControlCharacters(String(message ?? "")).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
}

/**
 * Native error text can embed absolute local paths (Pi's bundled docs, the
 * owner's home directory) and terminal-only advice ("Use /login"). Paths are
 * reduced to their last segment, lines that are only a path or terminal advice
 * are dropped, and the result is bounded.
 *
 * An unquoted path that contains spaces has no reliable end. Following words
 * are taken as part of it while they still contain a separator, so directory
 * names go; over-reduction is the safe side.
 */
export function sanitizePiErrorText(message: string, limit = 600): string {
  const token = "[^\\s\"'`()<>|]";
  const separator = "[\\\\/]";
  // More words of the same path: whitespace, then a word that still contains a separator.
  const continuation = `(?:[ \\t]+${token}*${separator}${token}*)*`;
  // Not preceded by a word character, ":" or "/": that would be a URL, a ratio such as 3/4, or the middle of a path.
  const lead = "(?<![\\w:/\\\\.])";
  const patterns = [
    // file: URLs.
    new RegExp(`file:${separator}{2,3}${token}+${continuation}`, "gi"),
    // Windows drive and UNC paths: the root alone is enough to recognise them.
    new RegExp(`${lead}(?:[A-Za-z]:${separator}|\\\\\\\\)${token}*${continuation}`, "g"),
    // POSIX absolute paths with at least two segments (a lone "/word" is a slash command or a top-level name).
    new RegExp(`${lead}/${token}+${separator}${token}*${continuation}`, "g"),
    // Relative paths that climb out of the working directory.
    new RegExp(`${lead}(?:\\.\\.${separator})+${token}*${continuation}`, "g"),
  ];
  // A quoted path may contain spaces; reduce everything inside the quotes. At least two separators:
  // a quoted slash command such as '/login x' is not a path.
  const quotedPath = /(['"`])((?:file:[\\/]{2,3}|[A-Za-z]:[\\/]|\\\\|\/|(?:\.\.[\\/])+)[^'"`\n]*[\\/][^'"`\n]*)\1/g;
  const accountRoot = /^(?:file:[\\/]{2,3})?(?:[A-Za-z]:)?[\\/](?:users|home)[\\/][^\\/]+[\\/]?$/i;
  const lastSegment = (value: string) => {
    // A path that ends at an account directory would leave the account name as its last segment.
    if (accountRoot.test(value)) return "…";
    const name = value.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
    return name ? `…/${name}` : "…";
  };
  const reduce = (line: string) => {
    let result = line.replace(quotedPath, (_match, quote: string, value: string) => `${quote}${lastSegment(value)}${quote}`);
    for (const pattern of patterns) result = result.replace(pattern, lastSegment);
    return result;
  };
  const lines = redactSecrets(piDisplayText(message)).replace(/\r\n?/g, "\n").replace(/[ \t]*Run '\/login[^'\n]*' to re-authenticate\.?/gi, "").split("\n").map(line => line.trim())
    .filter(line => line && !/^See:?$/i.test(line) && !/^Use \/login\b/i.test(line) && !/^Run '\/login/i.test(line) && !/^Hint: Start without extensions using ["']pi -ne["']\.?$/i.test(line))
    .map(reduce)
    // A line that was nothing but a path (a docs reference) carries no meaning once reduced.
    .filter(line => !/^…(?:\/[^\s]*)?$/.test(line));
  const text = lines.join(" ").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/**
 * Commands the Pi terminal UI handles itself. They are not session commands:
 * sent through `prompt` they would reach the model as prose. `route` says how
 * open-super-agent serves each one.
 *   rpc: native RPC command; bridge: native, through the bridge extension;
 *   host: open-super-agent implements the equivalent; terminal: needs a terminal or is
 *   presentation only, so it is declined with an explanation.
 */
export type PiBuiltinRoute = "rpc" | "bridge" | "host" | "terminal";
export const PI_TUI_BUILTIN_COMMANDS: Readonly<Record<string, PiBuiltinRoute>> = Object.freeze({
  settings: "host", model: "rpc", thinking: "rpc", "scoped-models": "host",
  login: "terminal", logout: "terminal",
  new: "host", resume: "host", name: "rpc", session: "rpc",
  tree: "bridge", fork: "rpc", clone: "rpc", compact: "rpc",
  import: "host", export: "rpc", share: "terminal", bug: "terminal", copy: "rpc",
  trust: "host", reload: "bridge", hotkeys: "terminal", changelog: "terminal", quit: "host",
  debug: "terminal", arminsayshi: "terminal", dementedelves: "terminal",
});

/**
 * Split "/name rest" the way Pi does (agent-session.ts:2270): the name ends at
 * the first space character only. "/model\nfoo" is prose to Pi, not a command.
 */
export function parsePiSlashCommand(text: string): { name: string; args: string } | undefined {
  if (!text.startsWith("/") || text.startsWith("//")) return;
  const space = text.indexOf(" ");
  const name = space < 0 ? text.slice(1) : text.slice(1, space);
  if (!name || /[\\/\s]/.test(name)) return;
  return { name, args: space < 0 ? "" : text.slice(space + 1).trim() };
}
