import type { ScreenJoin } from "../../src/client-protocol/remote-screen.js";
import { invoke } from "./desktop-bridge.js";

/** One viewing session's message channel, with `MessagePort` semantics: ordered,
 * no replay after `close`. Inbound: frame `ArrayBuffer`s and JSON events
 * (`stream`, `state`, `frame-ready`, `attached`, `native-visibility`, `closed`).
 * Outbound: viewer commands stamped with the session id and generation,
 * `received` and `input-focus`. */
export type ScreenViewerPort = {
  postMessage(message: Record<string, unknown>): void;
  /** Starts inbound delivery; the viewer calls it once, right after attach. */
  start(receive: (message: unknown) => void): void;
  close(): void;
};
export type ScreenViewerChannel = {
  /** Requests the session's port; a rejection is the open failure. `attach`
   * runs at most once, before or after the request settles; `fail` reports a
   * port that never arrives. */
  open(network: unknown, events: { attach(port: ScreenViewerPort): void; fail(reason: string): void }): Promise<unknown>;
  /** Stops waiting for the port and releases the session. Called once, when
   * the viewer is disposed, after it has closed any attached port. */
  close(): void;
};
/** Where a viewer's two Hub sockets live. Called once per viewer with its join.
 * Desktop: the Electron main process (the default); later the phone's native
 * transport, or a test fake. The Hub, not the transport, stays the authority. */
export type ScreenViewerTransport = (join: ScreenJoin) => ScreenViewerChannel;

/** The desktop App's main process owns both sockets (`electron/screen-viewer.mjs`)
 * and hands this document a `MessagePort` through a window message. */
export const electronScreenViewerTransport: ScreenViewerTransport = join => {
  let waiting: ((event: MessageEvent) => void) | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  const stopWaiting = () => { if (waiting) window.removeEventListener("message", waiting); waiting = undefined; clearTimeout(timer); };
  return {
    async open(network, events) {
      const channelId = crypto.randomUUID();
      const receive = (event: MessageEvent) => {
        if (event.source !== window || event.origin !== location.origin || event.data?.type !== "open-super-agent:screen-port:v1" || event.data.channelId !== channelId || event.data.sessionId !== join.session.id || event.ports.length !== 1) return;
        stopWaiting();
        const port = event.ports[0]!;
        events.attach({ postMessage: message => port.postMessage(message), start: deliver => { port.onmessage = e => deliver(e.data); port.start(); }, close: () => port.close() });
      };
      waiting = receive; window.addEventListener("message", receive);
      timer = setTimeout(() => { stopWaiting(); events.fail("screen_connect_timeout"); }, 10_000);
      try { return await invoke("screen_viewer_open", { channelId, join, network }); }
      catch (error) { stopWaiting(); throw error; }
    },
    close() { stopWaiting(); void invoke("screen_viewer_close", { sessionId: join.session.id }).catch(() => undefined); },
  };
};
