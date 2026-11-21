import type { PiModelRef, PiQueueMode, PiThinkingLevel } from "./pi-rpc-protocol.js";

/**
 * Pi-native session controls exposed by the Pi adapter. Every method acts on
 * exactly one native session. Methods that replace the session return the new
 * id; the adapter re-keys its live worker to it before resolving.
 */

export interface PiNativeModel extends PiModelRef {
  name: string;
  reasoning: boolean;
  input: string[];
  contextWindow: number;
}

/** Who chose the model the session currently runs:
 *  ticket: a dispatcher override for this turn's session;
 *  session: chosen in this conversation (native `/model`);
 *  bot-default: applied from the Bot-wide setting;
 *  native: Pi's own default or the model recorded in the session file. */
export type PiModelSource = "ticket" | "session" | "bot-default" | "native";

export interface PiNativeState {
  sessionId: string;
  sessionName?: string;
  /** Absent when Pi has no usable model (no provider is signed in). */
  model?: PiNativeModel;
  modelSource: PiModelSource;
  thinkingLevel: PiThinkingLevel;
  availableThinkingLevels: PiThinkingLevel[];
  isStreaming: boolean;
  isCompacting: boolean;
  steeringMode: PiQueueMode;
  followUpMode: PiQueueMode;
  autoCompactionEnabled: boolean;
  pending: { steering: string[]; followUp: string[] };
  /** unavailable: no App tools, approvals fail closed, tree navigation and reload are off. */
  bridge: "connected" | "unavailable";
  /** What extensions currently show in Pi's status line, widgets and window title. */
  ui: {
    status: Record<string, string>;
    widgets: Record<string, { lines: string[]; placement: "aboveEditor" | "belowEditor" }>;
    title?: string;
    /** Text an extension proposed for the composer. A proposal only: never overwrite the owner's draft with it. `revision` grows with each proposal. */
    editorText?: { text: string; revision: number };
  };
}

export interface PiNativeCommand {
  /** Without the leading slash; skills are `skill:<name>`. */
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill";
  scope?: string;
}

export interface PiNativeStats {
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  totalMessages: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  /** US dollars at list price; a subscription login still reports this notional figure. */
  costUsd: number;
  /**
   * Cost and tokens per `provider/model` that actually answered, most expensive first, as Pi's `/session` shows them.
   * Usage with no model of its own (tool and summary calls) is grouped under "Tools/summaries". Absent when it could not be read.
   */
  costByModel?: Array<{ key: string; costUsd: number; tokens: number }>;
  /** tokens/percent are null right after a compaction, until the next reply reports usage. */
  context?: { tokens: number | null; contextWindow: number; percent: number | null };
}

export interface PiNativeTreeNode {
  id: string;
  parentId: string | null;
  /** Session entry type: message, model_change, compaction, branch_summary, label … */
  type: string;
  role?: string;
  /** Single-line, bounded excerpt of the entry's text. */
  preview: string;
  label?: string;
  timestamp?: string;
  childIds: string[];
}
export interface PiNativeTree {
  /** Flat, in append order. Roots have parentId null. */
  nodes: PiNativeTreeNode[];
  leafId: string | null;
}

export interface PiNativeTool {
  name: string;
  active: boolean;
  /** direct, model-only, codemode, deferred or hidden. */
  exposure?: string;
  description?: string;
}

export interface PiNativeCompaction {
  summary: string;
  tokensBefore?: number;
  estimatedTokensAfter?: number;
}

export interface PiNativeBashResult {
  output: string;
  exitCode?: number | null;
  cancelled: boolean;
  truncated: boolean;
  fullOutputPath?: string;
}

/** Project-local Pi files (`.pi/…`, `.agents/skills`) are loaded only from a trusted project. */
export interface PiNativeProjectTrust {
  /** The workspace has such files. */
  hasProjectFiles: boolean;
  /** The owner's answer for this Bot and workspace; absent when never asked. Pi's own trust store is separate and untouched. */
  decision?: "yes" | "no";
  /** Whether the running process loaded them; absent when it could not say. */
  loaded?: boolean;
}

/** Models offered first and cycled through, like the terminal's `/scoped-models`. */
export interface PiNativeModelScope {
  /** This Bot's scope, applied to its Pi processes with `--models`. Empty: no Bot scope. */
  scope: PiModelRef[];
  /** `enabledModels` patterns from the owner's Pi settings, which apply when the Bot has no scope of its own. Read-only here. */
  nativePatterns: string[];
}

/** The four RPC setters that write the owner's global Pi `settings.json`. */
export type PiNativeGlobalSetting =
  | { key: "steeringMode" | "followUpMode"; value: PiQueueMode }
  | { key: "autoCompaction" | "autoRetry"; value: boolean };

export type PiNativeEvent =
  | { type: "state"; state: PiNativeState }
  | { type: "notify"; level: "info" | "warning" | "error"; text: string }
  | { type: "status"; key: string; text?: string }
  | { type: "widget"; key: string; lines?: string[]; placement: "aboveEditor" | "belowEditor" }
  | { type: "title"; title: string }
  | { type: "editor_text"; text: string }
  | { type: "extension_error"; extensionPath: string; event: string; error: string }
  /** native: an extension or Pi itself changed the session (ctx.newSession, ctx.fork, ctx.switchSession). */
  | { type: "session_replaced"; previousSessionId: string; sessionId: string; reason: "fork" | "clone" | "new" | "native" };

/**
 * A handle on one live process serving one native session, for controls that
 * must never start, resume or restore anything. Every method rejects with
 * `PiNativeRejectedError(…, "not-found")` once that exact process and session
 * generation is no longer current; it never falls over to another one.
 */
export interface PiNativeLiveSession {
  /** Opaque identity of this process and session generation. Not the session id, a path or a credential. */
  readonly token: string;
  isCurrent(): boolean;
  getState(): Promise<PiNativeState>;
  listModels(): Promise<unknown[]>;
  listCommands?(): Promise<PiNativeCommand[]>;
  /** `options.isCurrent` is awaited immediately before each native write. null drops the conversation's own choice. */
  setModel(model: PiModelRef | null, options: { isCurrent: () => Promise<boolean> }): Promise<PiNativeState>;
  setThinkingLevel(level: PiThinkingLevel | null, options: { isCurrent: () => Promise<boolean> }): Promise<PiNativeState>;
}

export interface PiNativeControls {
  /** Synchronous. Undefined unless a process is alive for this session right now; never starts one. */
  getLiveSession?(sessionId: string): PiNativeLiveSession | undefined;
  getState(sessionId: string): Promise<PiNativeState>;
  /** `get_available_models` of this session's process, unfiltered. Pass it through `parsePiModels` before it leaves the Host. */
  listModels(sessionId: string): Promise<unknown[]>;
  /** Extension commands, prompt templates and skills. Terminal built-ins are not session commands. */
  listCommands(sessionId: string): Promise<PiNativeCommand[]>;
  getStats(sessionId: string): Promise<PiNativeStats>;
  getTree(sessionId: string): Promise<PiNativeTree>;
  listForkPoints(sessionId: string): Promise<Array<{ entryId: string; text: string }>>;
  getLastAssistantText(sessionId: string): Promise<string | undefined>;
  listTools(sessionId: string): Promise<PiNativeTool[]>;
  subscribe(sessionId: string, listener: (event: PiNativeEvent) => void): () => void;

  /**
   * Session-only; allowed mid-run (takes effect at the next model call).
   * null drops the conversation's own choice at once: the session takes the Bot default, or Pi's own default when the Bot has none.
   */
  setModel(sessionId: string, model: PiModelRef | null): Promise<PiNativeState>;
  /**
   * Rejects a level the current model does not support instead of letting Pi clamp it silently.
   * null drops the conversation's own choice: the Bot effort applies if there is one; otherwise the level stays as it is.
   */
  setThinkingLevel(sessionId: string, level: PiThinkingLevel | null): Promise<PiNativeState>;
  setSessionName(sessionId: string, name: string): Promise<void>;
  followUp(sessionId: string, input: { text: string; files?: string[] }): Promise<"queued" | "handled">;
  clearQueue(sessionId: string): Promise<{ steering: string[]; followUp: string[] }>;
  compact(sessionId: string, input?: { instructions?: string }): Promise<PiNativeCompaction>;
  abortRetry(sessionId: string): Promise<void>;
  runUserBash(sessionId: string, input: {
    command: string; excludeFromContext?: boolean; onOutput?: (delta: string) => void; abortSignal?: AbortSignal;
  }): Promise<PiNativeBashResult>;
  exportHtml(sessionId: string, input?: { outputPath?: string }): Promise<{ path: string }>;
  setActiveTools(sessionId: string, names: string[]): Promise<PiNativeTool[]>;
  reload(sessionId: string): Promise<void>;
  setLabel(sessionId: string, input: { entryId: string; label: string | null }): Promise<void>;
  /** In place: the session id and file do not change, only the active leaf. */
  navigateTree(sessionId: string, input: { targetId: string; summarize?: boolean; customInstructions?: string; label?: string }):
    Promise<{ cancelled: boolean; leafId: string | null; editorText?: string }>;

  fork(sessionId: string, input: { entryId: string }): Promise<{ sessionId: string; text: string; cancelled: boolean }>;
  clone(sessionId: string): Promise<{ sessionId: string; cancelled: boolean }>;
  newSession(sessionId: string): Promise<{ sessionId: string; cancelled: boolean }>;

  getProjectTrust(sessionId: string): Promise<PiNativeProjectTrust>;
  /** Records the answer for this workspace and restarts the idle process so it takes effect. Nothing is written to Pi's own trust store. */
  setProjectTrust(sessionId: string, decision: "yes" | "no"): Promise<PiNativeProjectTrust>;
  /** The current branch as a native session file (header plus entries), as the terminal's `/export file.jsonl` writes it. */
  exportJsonl(sessionId: string, input: { outputPath: string }): Promise<{ path: string; entries: number }>;
  /** What importing a local session file would do. Reads its header only; changes nothing. Undefined: not a Pi session file. */
  inspectImport(sessionId: string, input: { path: string }): Promise<{ sessionId: string; name?: string; sameWorkspace: boolean; alreadyPresent: boolean } | undefined>;
  /** Copy a local native session file into the Bot's session directory and switch this conversation to it. Nothing leaves the machine. */
  importSession(sessionId: string, input: { path: string }): Promise<{ sessionId: string; cancelled: boolean }>;
  getModelScope(sessionId: string): Promise<PiNativeModelScope>;
  /** Sets this Bot's scope (null or empty clears it) and restarts the idle process. The owner's global Pi settings are not written. */
  setModelScope(sessionId: string, models: PiModelRef[] | null): Promise<PiNativeModelScope>;

  /** Changes the owner's native Pi defaults for every Pi session, terminal included. */
  setNativeGlobalSetting(sessionId: string, setting: PiNativeGlobalSetting): Promise<void>;
}

/** The operation needs an idle session (Pi refuses tree navigation, reload and compaction mid-run). */
export class PiNativeBusyError extends Error {
  constructor(readonly operation: string) { super(`Pi session is busy; ${operation} needs an idle session`); this.name = "PiNativeBusyError"; }
}
/** The operation needs the bridge extension, which is not connected for this session. */
export class PiNativeBridgeUnavailableError extends Error {
  constructor(readonly operation: string) { super(`Pi bridge is unavailable; ${operation} cannot run`); this.name = "PiNativeBridgeUnavailableError"; }
}
/**
 * An earlier model or thinking write to this Pi process got no confirmed
 * answer, so it may still take effect later. Nothing further is written to
 * that process: a second write could be overwritten by the first one landing
 * late. The state lasts until the process is replaced (the Bot restarts, or
 * the idle process is retired).
 */
export class PiNativeUncertainError extends Error {
  constructor(readonly operation: string, options?: ErrorOptions) {
    super(`An earlier model or thinking change in this Pi session has no confirmed result and may still take effect; ${operation} was not attempted`, options);
    this.name = "PiNativeUncertainError";
  }
}

/** The requested value is not offered by the session (unknown model, unsupported thinking level, unknown entry). */
export class PiNativeRejectedError extends Error {
  constructor(message: string, readonly reason: "model-unavailable" | "thinking-unsupported" | "not-found" | "invalid", readonly allowed?: string[]) {
    super(message); this.name = "PiNativeRejectedError";
  }
}
