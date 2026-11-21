import { readFile, stat } from "node:fs/promises";
import type { AdapterUsage, EngineStreamEvent } from "./adapter.js";
import { engineRetryReason } from "./turn-retry.js";
import { detectImageMediaTypeFromFile } from "../runtime/image-media.js";
import type {
  PiAssistantMessage, PiContentBlock, PiExtensionUiRequest, PiExtensionUiResponse, PiImageContent, PiMessage,
  PiSessionEntry, PiSessionEvent, PiSessionTreeNode, PiUsage,
} from "./pi-rpc-protocol.js";
import type { PiNativeTree, PiNativeTreeNode } from "./pi-native-types.js";
import { piLabelAnswer, piLabelValue, piQuestionSelection, piQuestionText } from "./pi-question-identity.js";

/** Pure translation between Pi's wire records and open-super-agent's engine stream. No process or socket state. */

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as PiContentBlock[]).filter(block => block?.type === "text" && typeof (block as { text?: unknown }).text === "string")
    .map(block => (block as { text: string }).text).join("");
};

export const piMessageText = (message: PiMessage | undefined): string => textOf(message?.content);
export const isPiAssistantMessage = (message: PiMessage | undefined): message is PiAssistantMessage => message?.role === "assistant";

export function addPiUsage(total: AdapterUsage | undefined, usage: PiUsage | undefined): AdapterUsage | undefined {
  if (!usage) return total;
  const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
  const cost = number(usage.cost?.total);
  // Same split as the Claude and DeepSeek adapters: `inputTokens` is uncached input, cache traffic is reported apart.
  const next: AdapterUsage = {
    inputTokens: (total?.inputTokens ?? 0) + number(usage.input),
    outputTokens: (total?.outputTokens ?? 0) + number(usage.output),
    cachedTokens: (total?.cachedTokens ?? 0) + number(usage.cacheRead) + number(usage.cacheWrite),
  };
  const costUsd = (total?.costUsd ?? 0) + cost;
  return costUsd > 0 ? { ...next, costUsd } : next;
}

/**
 * Cost and tokens per model across a whole session, the way Pi 1.5.2 groups
 * them for `/session` (usage-totals.ts `getUsageCostBreakdown`): assistant
 * messages by the model that answered, `usage` entries by their own model,
 * and tool, compaction and branch-summary usage under "Tools/summaries".
 */
export function piUsageCostBreakdown(entries: readonly PiSessionEntry[]): Array<{ key: string; costUsd: number; tokens: number }> {
  const totals = new Map<string, { costUsd: number; tokens: number }>();
  const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
  for (const entry of entries) {
    const message = entry.message as (PiMessage & { usage?: PiUsage; provider?: unknown; model?: unknown; responseModel?: unknown }) | undefined;
    let key: string | undefined, usage: PiUsage | undefined;
    if (entry.type === "message" && message?.role === "assistant") {
      key = `${String(message.provider)}/${String(message.responseModel ?? message.model)}`; usage = message.usage;
    } else if (entry.type === "usage") {
      key = `${String(entry.provider)}/${String(entry.model)}`; usage = entry.usage as PiUsage | undefined;
    } else if (entry.type === "message" && message?.role === "toolResult" && message.usage) {
      key = "Tools/summaries"; usage = message.usage;
    } else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
      key = "Tools/summaries"; usage = entry.usage as PiUsage;
    }
    if (!key || !usage || typeof usage !== "object") continue;
    const total = totals.get(key) ?? { costUsd: 0, tokens: 0 };
    total.costUsd += number(usage.cost?.total);
    total.tokens += number(usage.input) + number(usage.output) + number(usage.cacheRead) + number(usage.cacheWrite);
    totals.set(key, total);
  }
  return [...totals].map(([key, total]) => ({ key, ...total })).filter(item => item.costUsd > 0 || item.tokens > 0).sort((a, b) => b.costUsd - a.costUsd);
}

/** Text of a tool result: its text blocks, with a short marker for anything else. */
export function piToolResultText(result: unknown, limit = 64 * 1024): string {
  const content = (result as { content?: unknown })?.content;
  if (!Array.isArray(content)) return typeof result === "string" ? result.slice(0, limit) : "";
  const text = (content as PiContentBlock[]).map(block => {
    if (block?.type === "text") return String((block as { text?: unknown }).text ?? "");
    if (block?.type === "image") return "[image]";
    return "";
  }).join("");
  return text.length > limit ? `${text.slice(0, limit)}\n[output truncated]` : text;
}

/**
 * One turn's view of the event stream. `apply` returns the engine events to
 * publish; the mapper keeps what the final response needs.
 */
export class PiTurnMapper {
  /** Text of the assistant message currently streaming. */
  currentText = "";
  /** Text of the last completed assistant answer. */
  finalText = "";
  usage: AdapterUsage | undefined;
  lastAssistant: PiAssistantMessage | undefined;
  /** agent_start seen: a native run exists and must end with agent_settled. */
  runStarted = false;
  settled: { aborted: boolean } | undefined;
  private readonly openTools = new Map<string, { toolName: string; parent?: string; progress: string }>();
  private readonly publishedTools = new Set<string>();
  private textBlockOpen = false;
  private thinkingBlockOpen = false;
  private retryAttempt = 0;
  private compactionId = 0;
  private compactionStartedAt = 0;

  constructor(private readonly sessionId: string) {}

  get hasOpenTools(): boolean { return this.openTools.size > 0; }

  apply(event: PiSessionEvent): EngineStreamEvent[] {
    const sessionId = this.sessionId, out: EngineStreamEvent[] = [];
    switch (event.type) {
      case "agent_start": this.runStarted = true; this.settled = undefined; break;
      case "agent_settled": this.settled = { aborted: event.aborted }; break;
      case "message_start":
        if (isPiAssistantMessage(event.message)) { this.currentText = ""; this.textBlockOpen = false; this.thinkingBlockOpen = false; }
        break;
      case "message_update": {
        const update = event.assistantMessageEvent;
        if (update.type === "text_start") this.textBlockOpen = false;
        else if (update.type === "thinking_start") this.thinkingBlockOpen = false;
        else if (update.type === "text_delta" && update.delta) {
          this.currentText += update.delta;
          // The first fragment of a block starts a new line in the run card; later ones append to it.
          out.push({ type: "assistant_text", text: update.delta, ...(this.textBlockOpen ? { delta: true } : {}), sessionId });
          this.textBlockOpen = true;
        } else if (update.type === "thinking_delta" && update.delta) {
          out.push({ type: "thinking", text: update.delta, delta: this.thinkingBlockOpen, sessionId });
          this.thinkingBlockOpen = true;
        }
        break;
      }
      case "message_end":
        if (isPiAssistantMessage(event.message)) {
          const message = event.message;
          this.lastAssistant = message;
          this.usage = addPiUsage(this.usage, message.usage);
          const text = piMessageText(message);
          // A provider that sends no deltas still delivers the whole text here.
          if (text && !this.currentText) out.push({ type: "assistant_text", text, sessionId });
          if (text && message.stopReason !== "error" && message.stopReason !== "aborted") this.finalText = text;
          this.currentText = "";
        }
        break;
      case "tool_execution_start": {
        const parent = event.parentToolCallId;
        this.openTools.set(event.toolCallId, { toolName: event.toolName, ...(parent ? { parent } : {}), progress: "" });
        if (parent) {
          // Calls a tool made itself (codemode) have no transcript entry of their own; show them inside the parent.
          out.push({ type: "tool_progress", toolUseId: parent, text: `${event.toolName} ${compactJson(event.args)}\n`, delta: false, sessionId });
        } else if (!this.publishedTools.has(event.toolCallId)) {
          this.publishedTools.add(event.toolCallId);
          out.push({ type: "tool_use", toolName: event.toolName, toolInput: event.args, toolUseId: event.toolCallId, sessionId });
        }
        break;
      }
      case "tool_execution_update": {
        const tool = this.openTools.get(event.toolCallId);
        if (!tool || tool.parent) break;
        const text = piToolResultText(event.partialResult);
        if (!text || text === tool.progress) break;
        // Partial results are cumulative for the built-in tools; publish only what is new.
        const delta = text.startsWith(tool.progress) ? text.slice(tool.progress.length) : text;
        out.push({ type: "tool_progress", toolUseId: event.toolCallId, text: delta, delta: text.startsWith(tool.progress) && tool.progress.length > 0, sessionId });
        tool.progress = text;
        break;
      }
      case "tool_execution_end": {
        const tool = this.openTools.get(event.toolCallId);
        this.openTools.delete(event.toolCallId);
        if (tool?.parent ?? event.parentToolCallId) {
          if (event.isError) out.push({ type: "tool_progress", toolUseId: (tool?.parent ?? event.parentToolCallId)!, text: `${event.toolName} failed: ${piToolResultText(event.result, 2000)}\n`, delta: false, sessionId });
          break;
        }
        const structured = (event.result as { structuredContent?: { exit_code?: unknown; truncated?: unknown } } | undefined)?.structuredContent;
        out.push({
          type: "tool_result", toolUseId: event.toolCallId, toolName: event.toolName,
          output: piToolResultText(event.result), isError: event.isError,
          ...(typeof event.durationMs === "number" ? { durationMs: event.durationMs } : {}),
          ...(typeof structured?.exit_code === "number" ? { exitCode: structured.exit_code } : {}),
          ...(structured?.truncated === true ? { truncated: true } : {}),
          sessionId,
        });
        break;
      }
      case "auto_retry_start":
        this.retryAttempt = event.attempt;
        out.push({ type: "engine_retry", status: "waiting", attempt: event.attempt, reason: engineRetryReason(new Error(event.errorMessage)) ?? "connection", delayMs: event.delayMs, sessionId });
        break;
      case "auto_retry_end":
        out.push({
          type: "engine_retry", attempt: event.attempt || this.retryAttempt, delayMs: 0, sessionId,
          status: event.success ? "resumed" : /cancel/i.test(event.finalError ?? "") ? "cancelled" : "failed",
          reason: engineRetryReason(new Error(event.finalError ?? "")) ?? "connection",
        });
        break;
      case "compaction_start":
        this.compactionId++; this.compactionStartedAt = Date.now();
        out.push({ type: "context_compaction", id: `pi-compaction-${this.compactionId}`, status: "started", sessionId });
        break;
      case "compaction_end":
        out.push({
          type: "context_compaction", id: `pi-compaction-${Math.max(1, this.compactionId)}`, sessionId,
          status: event.result ? "completed" : "failed",
          ...(this.compactionStartedAt ? { durationMs: Date.now() - this.compactionStartedAt } : {}),
        });
        break;
      default: break;
    }
    return out;
  }
}

function compactJson(value: unknown, limit = 300): string {
  let text: string;
  try { text = JSON.stringify(value) ?? ""; } catch { text = ""; }
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** Inline images Pi accepts over RPC. Larger files are left for the agent's own `read` tool, which resizes. */
export const PI_INLINE_IMAGE_MAX_BYTES = 3 * 1024 * 1024;
export const PI_INLINE_IMAGE_MAX_COUNT = 8;

export interface PiPromptParts {
  message: string;
  images: PiImageContent[];
  /** Image attachments that were not sent as pixels, with the reason. */
  skippedImages: Array<{ file: string; reason: "model-has-no-vision" | "too-large" | "too-many" | "unreadable" }>;
}

/**
 * Build the RPC prompt. Every attachment is named by path so the agent can
 * open the original; images also travel as pixels when the model accepts
 * them. Pi silently drops images for a text-only model, so they are withheld
 * here and reported instead.
 */
export async function buildPiPrompt(input: { text: string; files: string[]; modelAcceptsImages: boolean }): Promise<PiPromptParts> {
  const images: PiImageContent[] = [], skippedImages: PiPromptParts["skippedImages"] = [];
  for (const file of input.files) {
    let mimeType: string | null;
    try { mimeType = await detectImageMediaTypeFromFile(file); } catch { mimeType = null; }
    if (!mimeType) continue;
    if (!input.modelAcceptsImages) { skippedImages.push({ file, reason: "model-has-no-vision" }); continue; }
    if (images.length >= PI_INLINE_IMAGE_MAX_COUNT) { skippedImages.push({ file, reason: "too-many" }); continue; }
    try {
      if ((await stat(file)).size > PI_INLINE_IMAGE_MAX_BYTES) { skippedImages.push({ file, reason: "too-large" }); continue; }
      images.push({ type: "image", data: (await readFile(file)).toString("base64"), mimeType });
    } catch { skippedImages.push({ file, reason: "unreadable" }); }
  }
  // Attachments alone are a valid message; do not start it with an empty line.
  const lines = [...(input.text ? [input.text] : []), ...input.files.map(file => `Attachment: ${file}`)];
  return { message: lines.join("\n"), images, skippedImages };
}

export interface PiDialogQuestion {
  /** Title and, below it, the explanation: the shared card shows this text and nothing else about the question. */
  question: string;
  header?: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect: false;
  /** Free-text dialogs: the card shows an input instead of choices. */
  input?: { kind: "text" | "multiline"; placeholder?: string; prefill?: string };
  /** Always stated: the shared card shows a free-text box unless told not to, and a typed answer to a choice would cancel the dialog. */
  allowFreeText: boolean;
  /** false: an empty answer is a valid value (an extension editor may return an empty string). */
  required?: false;
}

const DIALOG_COPY = {
  en: { yes: "Yes", no: "No", extension: "Extension", untitled: "Pi extension question", empty: "(empty)" },
  zh: { yes: "是", no: "否", extension: "扩展", untitled: "Pi 扩展问题", empty: "（空）" },
} as const;

/**
 * A question's title with its explanation under it. The shared question card
 * renders the question text and the options; an explanation sent in a field
 * of its own never reached the owner, who then confirmed a title alone.
 */
export function piQuestionWithDetail(title: string, detail: string | undefined): string {
  const body = detail?.trim();
  return body ? `${title}\n\n${body}` : title;
}

/**
 * Map an extension dialog to the shared question form. Blank titles and
 * options get visible text: the card drops blank ones, and answers are matched
 * back to the dialog by position (`piQuestionSelection`).
 */
export function piDialogQuestion(request: PiExtensionUiRequest, locale: "en" | "zh" = "en"): PiDialogQuestion | undefined {
  const copy = DIALOG_COPY[locale], header = copy.extension;
  const title = (value: string) => piQuestionText(value, copy.untitled);
  switch (request.method) {
    case "select": return { question: title(request.title), header, options: request.options.map(label => ({ label: piQuestionText(label, copy.empty) })), multiSelect: false, allowFreeText: false };
    case "confirm": return { question: piQuestionWithDetail(title(request.title), request.message), header, options: [{ label: copy.yes }, { label: copy.no }], multiSelect: false, allowFreeText: false };
    case "input": return { question: title(request.title), header, options: [], multiSelect: false, allowFreeText: true, required: false, input: { kind: "text", ...(request.placeholder ? { placeholder: request.placeholder } : {}) } };
    case "editor": return { question: title(request.title), header, options: [], multiSelect: false, allowFreeText: true, required: false, input: { kind: "multiline", ...(request.prefill ? { prefill: request.prefill } : {}) } };
    default: return;
  }
}

/**
 * Translate the form's answer back. A choice is taken by position, so the
 * extension receives exactly the option string it offered; a missing or
 * foreign answer cancels the dialog.
 */
export function piDialogResponse(
  request: PiExtensionUiRequest, question: PiDialogQuestion, updatedInput: unknown, locale: "en" | "zh" = "en",
): PiExtensionUiResponse {
  const cancelled: PiExtensionUiResponse = { type: "extension_ui_response", id: request.id, cancelled: true };
  const raw = piLabelAnswer(updatedInput, question.question);
  const labelAnswer = Array.isArray(raw) ? raw.find((value): value is string => typeof value === "string") : typeof raw === "string" ? raw : undefined;
  const selection = piQuestionSelection(updatedInput);
  if (selection && (request.method === "select" || request.method === "confirm")) {
    const position = selection.options.length === 1 ? selection.options[0]! : undefined;
    if (request.method === "select") {
      const value = position === undefined ? undefined : request.options[position];
      return value === undefined ? cancelled : { type: "extension_ui_response", id: request.id, value };
    }
    return position === 0 ? { type: "extension_ui_response", id: request.id, confirmed: true }
      : position === 1 ? { type: "extension_ui_response", id: request.id, confirmed: false } : cancelled;
  }
  const answer = (request.method === "input" || request.method === "editor") && selection?.text !== undefined ? selection.text : labelAnswer;
  if (answer === undefined) return cancelled;
  switch (request.method) {
    case "select": {
      // A label-only answer: the card shows labels trimmed, so options that look alike there are never guessed between.
      const match = piLabelValue(request.options.map(option => ({ label: option, value: option })), answer);
      return typeof match === "object" ? { type: "extension_ui_response", id: request.id, value: match.value } : cancelled;
    }
    case "confirm": {
      const copy = DIALOG_COPY[locale];
      if (answer === copy.yes) return { type: "extension_ui_response", id: request.id, confirmed: true };
      return answer === copy.no ? { type: "extension_ui_response", id: request.id, confirmed: false } : cancelled;
    }
    case "input": case "editor": return { type: "extension_ui_response", id: request.id, value: answer };
    default: return cancelled;
  }
}

export const isPiDialog = (request: PiExtensionUiRequest): boolean =>
  request.method === "select" || request.method === "confirm" || request.method === "input" || request.method === "editor";

/** A reply that failed or was cut off and carries no text is still listed by Pi's tree (tree-selector.ts:347-357); say how it ended. */
function failedReplyPreview(message: PiMessage): string {
  if (message.role !== "assistant") return "";
  const reason = (message as PiAssistantMessage).stopReason;
  if (!reason || reason === "stop" || reason === "toolUse") return "";
  const detail = (message as PiAssistantMessage).errorMessage;
  return `[${String(reason)}]${typeof detail === "string" && detail.trim() ? ` ${detail}` : ""}`;
}

function entryPreview(node: PiSessionTreeNode, limit = 160): string {
  const entry = node.entry;
  const message = entry.message as (PiMessage & { command?: unknown }) | undefined;
  const raw = message?.role === "bashExecution" && typeof message.command === "string" ? `!${message.command}`
    : message ? piMessageText(message) || failedReplyPreview(message)
    : typeof entry.summary === "string" ? entry.summary
      : entry.type === "model_change" ? `${String(entry.provider ?? "")}/${String(entry.modelId ?? "")}`
        : entry.type === "thinking_level_change" ? String(entry.thinkingLevel ?? "")
          : entry.type === "session_info" ? String(entry.name ?? "")
            : "";
  const line = raw.replace(/\s+/g, " ").trim();
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

/**
 * Flatten `get_tree` into nodes that are safe to hand to a UI, in the order
 * the entries were appended. Iterative: a session without branches is one
 * chain as deep as it is long.
 */
export function piNativeTree(tree: PiSessionTreeNode[], leafId: string | null): PiNativeTree {
  const nodes: Array<PiNativeTreeNode & { order: number }> = [];
  const stack: PiSessionTreeNode[] = [...tree].reverse();
  while (stack.length) {
    const node = stack.pop()!;
    const entry = node?.entry;
    if (!entry || typeof entry.id !== "string") continue;
    const children = Array.isArray(node.children) ? node.children : [];
    nodes.push({
      id: entry.id, parentId: typeof entry.parentId === "string" ? entry.parentId : null, type: String(entry.type),
      ...(entry.message && typeof entry.message.role === "string" ? { role: entry.message.role } : {}),
      preview: entryPreview(node),
      ...(node.label ? { label: node.label } : {}),
      ...(typeof entry.timestamp === "string" ? { timestamp: entry.timestamp } : {}),
      childIds: children.map(child => child.entry?.id).filter((id): id is string => typeof id === "string"),
      order: nodes.length,
    });
    for (let index = children.length - 1; index >= 0; index--) stack.push(children[index]!);
  }
  // Depth-first order equals append order only without branches. Timestamps restore it; ties keep parent before child.
  if (nodes.every(node => node.timestamp)) nodes.sort((a, b) => (a.timestamp! < b.timestamp! ? -1 : a.timestamp! > b.timestamp! ? 1 : a.order - b.order));
  return { nodes: nodes.map(({ order: _order, ...node }) => node), leafId };
}

/** The user text stored at an entry, used to refill the composer after navigating to a user message. */
export function piUserEntryText(tree: PiSessionTreeNode[], entryId: string): string | undefined {
  const stack = [...tree];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.entry?.id === entryId) return node.entry.message?.role === "user" ? piMessageText(node.entry.message) : undefined;
    stack.push(...node.children);
  }
  return;
}
