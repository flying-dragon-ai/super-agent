import { blocksText, type Block, type Message } from "../../src/client-protocol/index.js";
import { isContextMaintenance, isRunActive, nativeRun } from "../../src/client-protocol/run.js";
import { t } from "./i18n.js";

export type ConversationPreviewStatus = { key: "running" | "delivering"; seq: number };
type Preview = { preview: string; previewStatus?: ConversationPreviewStatus | null; lastContentSeq: number };

/** Exact producer labels only. A matching string alone never proves provenance. */
export function systemRunPreview(text: string): ConversationPreviewStatus["key"] | undefined {
  if (text === "任务处理中" || text === "Task is running") return "running";
  if (text === "正在交付结果" || text === "Delivering result") return "delivering";
}

/** Keep stored text intact and bind the presentation hint to this content event. */
export function projectConversationPreview(message: Pick<Message, "blocks" | "authorType"> | undefined, seq: number): Pick<Preview, "preview" | "previewStatus"> {
  const preview = message ? conversationBlocksPreview(message.blocks) : "";
  const visible = message?.blocks.filter(block => block.type !== "steering" && !(block.type === "card" && block.extra?.promptQueue));
  const block = visible?.length === 1 ? visible[0] : undefined;
  const run = block?.type === "card" ? nativeRun(block) : undefined;
  const key = systemRunPreview(preview);
  const status = message?.authorType === "bot" && block?.type === "card" && block.summary?.trim() === preview && run && key
    && (key === "delivering" ? run.phase === "delivering" || run.phase === "stopping" : isRunActive(run.phase) && run.phase !== "delivering");
  return { preview, previewStatus: status ? { key, seq } : null };
}

/** Translate at render time so cached/offline lists follow language changes. */
export function conversationActivityPreview(activity: Preview | undefined): string {
  if (!activity) return "";
  const status = activity.previewStatus;
  if (status && status.seq === activity.lastContentSeq && status.key === systemRunPreview(activity.preview)) {
    return status.key === "running" ? t("任务处理中") : t("正在交付结果");
  }
  return activity.preview;
}

/** Sidebar projection only. Card summaries must not replace the full text used
 * by search, copy, export, forwarding or the message itself. */
export function conversationBlocksPreview(blocks: Block[]): string {
  // Untitled images become one localized count instead of repeated "[image]" markers.
  const images = blocks.filter(block => block.type === "image" && !block.title?.trim()).length;
  let imageCountShown = false;
  const parts = blocks.filter(block => block.type !== "steering" && !(block.type === "card" && block.extra?.promptQueue))
    .map(block => {
      if (block.type === "image" && !block.title?.trim()) {
        if (imageCountShown) return "";
        imageCountShown = true;
        // Keep the first image's position, including before long text excerpts.
        return images === 1 ? t("[图片]") : t("[{0} 张图片]", String(images));
      }
      if (block.type !== "card") return blocksText([block]);
      const run = nativeRun(block), current = run?.current;
      // The generic card summary must not hide live foreground maintenance.
      if (run?.phase === "working" && current?.status === "running" && isContextMaintenance(current)) {
        return current.name === "context_checkpoint" ? t("正在整理上下文摘要") : t("正在压缩上下文");
      }
      return block.summary?.trim() || blocksText([block]);
    });
  return parts.filter(Boolean).join("\n").slice(0, 120);
}

/** Presentation-only excerpts. Keep code contents, URLs and unfinished prose
 * intact; remove Markdown framing without mounting a renderer for every row.
 * Stored text, search matching and copy/export always retain the original. */
export function conversationPreview(text: string): string {
  return text.split(/(```[^\n]*\n[\s\S]*?(?:```|$)|~~~[^\n]*\n[\s\S]*?(?:~~~|$)|`[^`\n]+`|!?\[[^\]\n]*\]\([^\s)]*(?:\s+"[^"\n]*")?\)|https?:\/\/\S+)/g)
    .map((part, index, parts) => {
      if (index % 2) {
        if (/^!?\[/.test(part)) return part.slice(part.indexOf("[") + 1, part.indexOf("]"));
        if (part.startsWith("http")) return part;
        if (part.startsWith("```") || part.startsWith("~~~")) return part.replace(/^[^\n]*\n/, "").replace(/(?:```|~~~)$/, "");
        return part.slice(1, -1);
      }
      // Splitting around inline code/links does not create a Markdown line.
      // Only strip block framing at an original line boundary.
      const startsLine = index === 0 || parts[index - 1]!.endsWith("\n");
      const lineBoundary = (offset: number) => offset > 0 || startsLine;
      return part.replace(/\*\*([^*\n]+)\*\*/g, "$1")
        .replace(/(^|\s)\*([^*\n]+)\*(?=$|[\s.,!?，。！？])/g, "$1$2")
        .replace(/^[ \t]{0,3}(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+(?:\[[ xX]\][ \t]*)?)/gm, (marker, offset: number) => lineBoundary(offset) ? "" : marker)
        .replace(/^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)+\|?[ \t]*$/gm, (row, offset: number) => lineBoundary(offset) ? "" : row)
        .replace(/^[ \t]*\|([^\n]+)\|[ \t]*$/gm, (row, cells: string, offset: number) => lineBoundary(offset) ? cells.split("|").map(cell => cell.trim()).join(" · ") : row);
    }).join("").replace(/\s+/g, " ").trim();
}
