import { blocksText, type Block, type CardElement } from "../../src/client-protocol/index.js";
import type { MarkdownPlainRequest, MarkdownPlainResult } from "./markdown.worker.js";
import { claimClipboardWrite } from "./clipboard-write.js";

/** The readable (Markdown-free) copy of a whole message, for pasting into chat
 * apps. Its structure is `blocksText` itself: only the fields Content.tsx
 * renders as Markdown are converted first. Titles, buttons, form labels,
 * options and attachment names are literal text and stay untouched. */
function withMarkdown(blocks: Block[], convert: (markdown: string) => string): Block[] {
  const field = (text: string) => text.trim() ? convert(text) : text;
  const element = (item: CardElement): CardElement => ({
    ...item,
    ...(item.text !== undefined && (item.type === "markdown" || item.type === "collapsible") ? { text: field(item.text) } : {}),
    ...(item.children ? { children: item.children.map(element) } : {}),
  });
  return blocks.map(block => block.type === "text" ? { ...block, text: field(block.text) }
    : block.type === "card" ? { ...block, elements: block.elements.map(element) } : block);
}

// Converted fields, most recently used last, so a second tap or the selection
// view needs no Worker round trip. Bounded by source plus converted size; the
// newest field always stays, so one very long message is still ready for a
// synchronous write.
const CACHE_CHARS = 600_000;
const converted = new Map<string, string>();
let convertedChars = 0;
function cached(markdown: string): string | undefined {
  const value = converted.get(markdown);
  if (value !== undefined) { converted.delete(markdown); converted.set(markdown, value); }
  return value;
}
function remember(markdown: string, plain: string): void {
  const cost = (key: string, value: string) => key.length + value.length;
  const existing = converted.get(markdown);
  if (existing !== undefined) { converted.delete(markdown); convertedChars -= cost(markdown, existing); }
  converted.set(markdown, plain); convertedChars += cost(markdown, plain);
  for (const [key, value] of converted) { if (convertedChars <= CACHE_CHARS || key === markdown) break; converted.delete(key); convertedChars -= cost(key, value); }
}

// A second instance of the Markdown Worker script, outside the rendering
// queue: a long copy conversion cannot delay message layout, and its failures
// do not count against rendering recovery. One conversion runs at a time.
type Job = { texts: string[]; settle: (values: string[] | undefined) => void };
const waiting: Job[] = [];
let worker: Worker | undefined, current: (Job & { id: number }) | undefined, sequence = 0;
let watchdog: ReturnType<typeof setTimeout> | undefined, idle: ReturnType<typeof setTimeout> | undefined;
function stopWorker(): void {
  clearTimeout(watchdog); clearTimeout(idle);
  if (worker) { worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null; worker.terminate(); worker = undefined; }
}
function finish(values?: string[]): void {
  const finished = current; current = undefined; clearTimeout(watchdog);
  finished?.settle(values);
  pump();
  if (!current) { clearTimeout(idle); idle = setTimeout(stopWorker, 30_000); }
}
// A stalled or crashed realm is replaced for the next conversion, never reused.
function fail(): void { stopWorker(); finish(); }
function pump(): void {
  if (current || !waiting.length) return;
  const next = waiting.shift()!;
  // An earlier conversion (the sheet preparing, then a tap) may have answered this one.
  const known = next.texts.map(cached);
  if (known.every(value => value !== undefined)) { next.settle(known as string[]); pump(); return; }
  clearTimeout(idle);
  const job = { ...next, id: ++sequence }; current = job;
  try {
    if (!worker) {
      const active = new Worker(new URL("./markdown.worker.ts", import.meta.url), { type: "module" }); worker = active;
      active.onmessage = (event: MessageEvent<MarkdownPlainResult>) => {
        if (worker !== active || current?.id !== event.data.id) return;
        // A rejected document leaves a healthy Worker; only its own copy falls back.
        finish("plain" in event.data && event.data.plain.length === current.texts.length ? event.data.plain : undefined);
      };
      active.onerror = event => { event.preventDefault(); if (worker === active) fail(); };
      active.onmessageerror = () => { if (worker === active) fail(); };
    }
    const request: MarkdownPlainRequest = { id: job.id, plain: job.texts };
    worker.postMessage(request);
    watchdog = setTimeout(() => { if (current === job) fail(); }, 10_000);
  } catch { fail(); }
}

/** The readable copy, if every Markdown field of these blocks is already converted. */
export function messagePlainTextNow(blocks: Block[]): string | undefined {
  let ready = true;
  const plain = withMarkdown(blocks, markdown => { const value = cached(markdown); if (value === undefined) ready = false; return value ?? markdown; });
  return ready ? blocksText(plain) : undefined;
}

/** Convert in the Worker. `text` never rejects: it resolves undefined when the
 * conversion is unavailable, so a caller can fall back to the original text
 * and say so. `cancel` withdraws a conversion that has not started. */
export function prepareMessagePlainText(blocks: Block[]): { text: Promise<string | undefined>; cancel: () => void } {
  // Values are held for this request: cache eviction cannot leave a field unconverted.
  const values = new Map<string, string>(), missing: string[] = [];
  withMarkdown(blocks, markdown => {
    const value = cached(markdown);
    if (value !== undefined) values.set(markdown, value); else if (!missing.includes(markdown)) missing.push(markdown);
    return markdown;
  });
  const complete = () => blocksText(withMarkdown(blocks, markdown => values.get(markdown)!));
  if (!missing.length) return { text: Promise.resolve(complete()), cancel: () => undefined };
  let job: Job | undefined;
  const text = new Promise<string | undefined>(resolve => {
    job = { texts: missing, settle: plain => {
      if (!plain) { resolve(undefined); return; }
      missing.forEach((markdown, index) => { values.set(markdown, plain[index]!); remember(markdown, plain[index]!); });
      resolve(complete());
    } };
    waiting.push(job); pump();
  });
  return { text, cancel: () => { const index = job ? waiting.indexOf(job) : -1; if (index >= 0) waiting.splice(index, 1)[0]!.settle(undefined); } };
}

export class MessageCopySuperseded extends Error {
  constructor() { super("A newer message copy superseded this one."); this.name = "MessageCopySuperseded"; }
}

/** Call synchronously inside the tap or click. Resolves true once the
 * clipboard holds the readable copy and false once it holds the original text
 * because conversion was unavailable. Rejects when the clipboard refused the
 * write or a newer copy superseded this conversion. */
export function copyMessagePlainText(blocks: Block[]): Promise<boolean> {
  const current = claimClipboardWrite();
  const requireCurrent = () => {
    if (!current()) throw new MessageCopySuperseded();
  };
  // Native selection Copy/Cut does not use the async browser API. Observe only
  // while this operation is pending, without intercepting or changing its data.
  const nativeCopy = () => { claimClipboardWrite(); };
  const document = globalThis.document;
  document?.addEventListener("copy", nativeCopy, true);
  document?.addEventListener("cut", nativeCopy, true);
  const stop = () => { document?.removeEventListener("copy", nativeCopy, true); document?.removeEventListener("cut", nativeCopy, true); };
  let readable = true;
  // Another visible conversation pane can also copy. Translate its cancellation
  // even if the browser wraps the rejected item data in its own exception.
  const completed = (write: Promise<void>) => write.then(() => { requireCurrent(); return readable; }, error => { requireCurrent(); throw error; }).finally(stop);
  try {
    const ready = messagePlainTextNow(blocks);
    if (ready !== undefined) return completed(navigator.clipboard.writeText(ready));
    const text = prepareMessagePlainText(blocks).text.then(plain => { readable = plain !== undefined; return plain ?? blocksText(blocks); });
    const later = () => completed(text.then(value => { requireCurrent(); return navigator.clipboard.writeText(value); }));
    // WebKit honours a clipboard write only while the tap is active, but lets
    // the item's data settle afterwards (image-clipboard.ts relies on the same).
    if (typeof ClipboardItem !== "undefined" && typeof navigator.clipboard.write === "function") {
      let item: ClipboardItem | undefined;
      const data = text.then(value => { requireCurrent(); return new Blob([value], { type: "text/plain" }); });
      // A rejected write or unsupported constructor may never consume its data.
      void data.catch(() => undefined);
      try { item = new ClipboardItem({ "text/plain": data }); } catch { /* promised data is not supported here */ }
      // Engines without promised items may still accept a later text write;
      // where they do not, that write rejects and the caller reports it.
      // Do not resurrect a refused/cancelled write: a newer system or code-block
      // copy may already own the clipboard, independently of this helper.
      if (item) return completed(navigator.clipboard.write([item]));
    }
    return later();
  } catch (error) { stop(); return Promise.reject(error); }
}
