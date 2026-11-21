import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Copy, ExternalLink, FileText, Forward, LoaderCircle, MessageSquare, TextSelect, RotateCcw, ListChecks, Trash2 } from "lucide-react";
import { blocksText, type Block, type Message } from "../../src/client-protocol/index.js";
import type { HubConnection } from "./connection.js";
import { useMessageExport } from "./message-export.js";
import { CreationDialog } from "./CreationDialog.js";
import { ReferencePreview } from "./BotReferences.js";
import { messageExcerpt } from "./MessageReference.js";
import { prepareMessagePlainText } from "./message-plain-text.js";
import { t, useLocale } from "./i18n.js";

// Phone messages open this sheet by holding the bubble or activating its row.
// Desktop keeps its inline hover/focus bar (App.tsx).

export type MessageSheetActions = {
  /** Must write the clipboard synchronously (Safari only allows it inside the tap). */
  copy: () => void;
  /** Receives the sheet so the composer can take focus inside the same tap. */
  quote: (dialog: HTMLDialogElement | null) => void;
  forward: () => void;
  retry: () => void;
  select: () => void;
  delete: () => void;
  deletionAvailable: boolean;
};

/** `message` is the live copy looked up by ID; undefined once it has left this conversation. */
export function MessageActionSheet({ connection, message, meta, quoteBlocked, canRetry, retryBlocked, returnFocus, close, actions }: { connection: HubConnection; message?: Message; meta: string; quoteBlocked: boolean; canRetry: boolean; retryBlocked: boolean; returnFocus: RefObject<HTMLElement | null>; close: () => void; actions: MessageSheetActions }) {
  useLocale();
  const note = useId();
  const [selecting, setSelecting] = useState(false);
  const selectable = useRef<HTMLTextAreaElement>(null), selectTrigger = useRef<HTMLButtonElement>(null);
  const messageId = message?.id, blocks = message?.blocks;
  // The selectable text is the readable copy (message-plain-text.ts), prepared
  // while the sheet is open so Copy can write it inside the tap. `text` is
  // absent when conversion was unavailable; the original text is shown then.
  const [prepared, setPrepared] = useState<{ id: string; blocks: Block[]; text?: string }>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!messageId || !blocks) return;
    let current = true;
    const job = prepareMessagePlainText(blocks);
    void job.text.then(text => { if (current) setPrepared({ id: messageId, blocks, text }); });
    return () => { current = false; job.cancel(); };
  }, [messageId, blocks, attempt]);
  // Never another message's text. A streaming update keeps the last readable
  // version on screen until its successor is ready, instead of blanking.
  const shown = message && prepared?.id === message.id ? prepared : undefined;
  const selectionText = shown && message ? shown.text ?? blocksText(message.blocks) : undefined;
  const selectionReady = selectionText !== undefined, autoSelected = useRef(false);
  useLayoutEffect(() => {
    if (!selecting) { autoSelected.current = false; return; }
    if (autoSelected.current) return;
    selectable.current?.focus();
    // Select once, when the text first arrives. Later streaming updates must
    // not replace a range the reader has since chosen.
    if (selectionReady) { selectable.current?.select(); autoSelected.current = true; }
  }, [selecting, selectionReady]);
  const { exported, send: exportMessage } = useMessageExport(connection, messageId);
  const forwardReady = !!message && ["complete", "error"].includes(message.status);
  return <CreationDialog title={t("消息操作")} closeLabel={t("关闭消息操作")} close={close} returnFocus={returnFocus}>
    {message && selecting ? <div className="message-text-selection"><textarea ref={selectable} aria-label={t("可选择的消息文本")} aria-busy={!selectionReady || undefined} readOnly value={selectionText ?? ""} rows={10}/>{!selectionReady ? <p className="muted" role="status">{t("正在整理文本…")}</p> : shown?.text === undefined && <p className="muted" role="status">{t("未能整理格式，以下为原文。")}</p>}<button type="button" onClick={() => { setSelecting(false); requestAnimationFrame(() => selectTrigger.current?.focus()); }}>{t("返回消息操作")}</button></div> : message ? <>
      <div className="message-sheet-preview"><small>{meta}</small><p><ReferencePreview text={messageExcerpt(message)}/></p></div>
      <div className="mobile-chat-action-list message-sheet-list">
        <button type="button" onClick={actions.copy}><Copy size={20}/><span className="action-label">{t("复制消息")}</span></button>
        <button type="button" ref={selectTrigger} onClick={() => { if (shown && shown.text === undefined) { setPrepared(undefined); setAttempt(value => value + 1); } setSelecting(true); }}><TextSelect size={20}/><span className="action-label">{t("选择文本")}</span></button>
        <button type="button" className={quoteBlocked ? "action-with-note" : undefined} aria-label={t("引用回复")} aria-describedby={quoteBlocked ? `${note}-quote` : undefined} disabled={quoteBlocked} onClick={(event) => actions.quote(event.currentTarget.closest("dialog"))}><MessageSquare size={20}/><span className="action-text"><span>{t("引用回复")}</span>{quoteBlocked && <small id={`${note}-quote`}>{t("对话已归档，恢复后可引用")}</small>}</span></button>
        <button type="button" className={forwardReady ? undefined : "action-with-note"} aria-label={t("转发消息")} aria-describedby={forwardReady ? undefined : `${note}-forward`} disabled={!forwardReady} onClick={actions.forward}><Forward size={20}/><span className="action-text"><span>{t("转发消息")}</span>{!forwardReady && <small id={`${note}-forward`}>{t("生成完成后可转发")}</small>}</span></button>
      </div>
      <div className="mobile-chat-action-list message-sheet-list">
        <button type="button" disabled={!actions.deletionAvailable} onClick={actions.select}><ListChecks size={20}/><span className="action-label">{t("多选消息")}</span></button>
        <button type="button" className="message-delete-action" disabled={!actions.deletionAvailable} onClick={actions.delete}><Trash2 size={20}/><span className="action-label">{t("删除消息")}</span></button>
        {!actions.deletionAvailable && <p className="muted">{t("请更新主机后使用消息删除。")}</p>}
      </div>
      <div className="mobile-chat-action-list message-sheet-list">
        {/* aria-disabled while busy: a natively disabled button would drop keyboard focus mid-export. */}
        <button type="button" className={exported?.busy ? "action-with-note" : undefined} aria-label={t("导出到 Google 文档")} aria-describedby={exported?.busy || exported?.error ? `${note}-export` : undefined} aria-disabled={exported?.busy} onClick={() => { if (messageId && !exported?.busy) void exportMessage(); }}>{exported?.busy ? <LoaderCircle size={20} className="spin"/> : <FileText size={20}/>}<span className="action-text"><span>{t("导出到 Google 文档")}</span>{exported?.busy && <small id={`${note}-export`}>{t("正在导出…")}</small>}</span></button>
        {!exported?.busy && exported?.error && <p id={`${note}-export`} className="message-sheet-error error-text" role="alert">{exported.error}</p>}
        {exported?.url && <a href={exported.url} target="_blank" rel="noopener noreferrer"><ExternalLink size={20}/><span className="action-label">{t("打开 Google 文档")}</span></a>}
        {canRetry && <button type="button" disabled={retryBlocked} className={retryBlocked ? "action-with-note" : undefined} aria-label={t("重新发送消息")} aria-describedby={retryBlocked ? `${note}-retry` : undefined} onClick={actions.retry}><RotateCcw size={20}/><span className="action-text"><span>{t("重新发送消息")}</span>{retryBlocked && <small id={`${note}-retry`}>{t("对话已归档，恢复后可重新发送。")}</small>}</span></button>}
      </div>
    </> : <p className="message-sheet-gone" role="status">{t("这条消息已不在当前对话中，可能已被删除。")}</p>}
  </CreationDialog>;
}
