import { createContext, useSyncExternalStore } from "react";
import { observeElementRect, type Virtualizer } from "@tanstack/react-virtual";

/** Desktop rows read at 760px. A reply can only be widened while its chat
 * area offers this much real extra room beyond that. */
export const REPLY_READING_WIDTH = 760;
export const REPLY_WIDTH_ROOM = REPLY_READING_WIDTH + 96;

// View state only: which replies this window has widened. It outlives row
// virtualization and conversation switches, and ends with the App. It is never
// written to the message, the Host or saved preferences.
const LIMIT = 512;
const widened = new Set<string>(), listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

/** One reply as this paired device sees it on one host. */
export const replyWidthKey = (host: string | undefined, device: string | undefined, conversationId: string, messageId: string) => JSON.stringify([host ?? "", device ?? "", conversationId, messageId]);
export const isReplyWide = (key: string) => widened.has(key);
export function setReplyWide(key: string, wide: boolean): void {
  if (wide === widened.has(key)) return;
  if (wide) { widened.add(key); while (widened.size > LIMIT) widened.delete(widened.values().next().value!); }
  else widened.delete(key);
  for (const listener of [...listeners]) listener();
}
export function useReplyWide(key: string | undefined): boolean {
  return useSyncExternalStore(subscribe, () => key !== undefined && widened.has(key));
}

/** The same desktop test as the side conversation and image actions: native
 * phones and tablets, mobile browsers and iPad's desktop-class browser are out,
 * whatever their window width. */
export function desktopReplyWidth(platform: string, device: Pick<Navigator, "userAgent" | "platform" | "maxTouchPoints"> = navigator): boolean {
  return !["ios", "android"].includes(platform) && !/Android|iPhone|iPad|iPod/.test(device.userAgent) && !(device.platform === "MacIntel" && device.maxTouchPoints > 1);
}

/** Provided by the desktop main message list only. `measure` hands a row's new
 * height to the virtual list once its new width has been committed. */
export type ReplyWidth = { measure(row: Element | null | undefined): void };
export const ReplyWidthContext = createContext<ReplyWidth | undefined>(undefined);

/** The message list already observes its viewport size. Publish from that same
 * observer whether replies have room to widen, as an attribute for CSS: an
 * ancestor size container would change what `cqw` means inside message tables. */
export function observeReplyWidthRoom(instance: Virtualizer<HTMLDivElement, HTMLElement>, callback: (rect: { width: number; height: number }) => void): void | (() => void) {
  const node = instance.scrollElement;
  const stop = observeElementRect(instance, rect => {
    if (node) {
      const style = getComputedStyle(node);
      node.toggleAttribute("data-reply-width-room", rect.width - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0) >= REPLY_WIDTH_ROOM);
    }
    callback(rect);
  });
  return () => { stop?.(); node?.removeAttribute("data-reply-width-room"); };
}
