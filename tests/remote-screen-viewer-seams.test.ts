// RemoteScreenViewer seams (#48/#49 P1): an injected transport and an injected
// input-validity check, with the Electron main-process port as the default.
// Synthetic session data only; no capture, no sockets, no native input.
import { afterEach, expect, it, vi } from "vitest";
import type { ScreenJoin } from "../src/client-protocol/remote-screen.js";
import { writeScreenFrame } from "../src/client-protocol/screen-wire.js";
import { RemoteScreenViewer, screenCanvasFocused, type ViewerState } from "../client/src/remote-screen-viewer.js";
import type { ScreenViewerPort, ScreenViewerTransport } from "../client/src/screen-viewer-transport.js";

class FakeDecoder { state = "unconfigured"; configure() { this.state = "configured"; } decode() {} close() { this.state = "closed"; } }
class FakeChunk { constructor(readonly init: unknown) {} }
Object.assign(globalThis, { VideoDecoder: FakeDecoder, EncodedVideoChunk: FakeChunk });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const display = { id: "display", nativeId: "1", name: "Display", revision: 1, x: 0, y: 0, width: 1280, height: 720, scale: 1, rotation: 0 as const };
const session = { id: "screen_seam", desktopId: "desktop_seam", deviceId: "viewer_seam", deviceName: "Viewer", generation: "generation_seam", display, controlAllowed: true, state: "viewing" as const, createdAt: 1 };
const join: ScreenJoin = { session, controlTicket: "c".repeat(43), mediaTicket: "m".repeat(43), expiresAt: 2, serverTime: 1 };
const network = { url: "https://example.invalid", publicKey: "synthetic" };
const lease = { id: "l".repeat(43), expiresAt: Date.now() + 60_000, challenge: "h".repeat(43), challengeExpiresAt: Date.now() + 60_000 };
const stamp = { sessionId: session.id, generation: session.generation };
const stream = (streamGeneration: number) => ({ type: "stream", streamGeneration, geometryRevision: 1, codec: "vp8", codecString: "vp8", width: 1280, height: 720, contentRect: { x: 0, y: 0, width: 1280, height: 720 } });
const ready = (streamGeneration: number, frameSequence: number) => ({ type: "frame-ready", ...stamp, streamGeneration, frameSequence, expiresAt: Date.now() + 60_000 });
const frame = (streamGeneration: number, sequence: number) => writeScreenFrame({ key: true, codec: "vp8", sequence, geometryRevision: 1, streamGeneration, captureMs: 1, width: 1280, height: 720 }, new Uint8Array([1, 2, 3])).buffer;
const viewing = { type: "state", session, serverTime: 1 };
const controlling = (streamGeneration: number) => ({ type: "state", session: { ...session, state: "controlling" }, serverTime: 1, streamGeneration, lease });
const canvas = () => ({ focus: vi.fn() }) as unknown as HTMLCanvasElement & { focus: ReturnType<typeof vi.fn> };

/** A transport the test drives: it records the open request and hands over a recording port. */
function fakeTransport({ rejectOpen }: { rejectOpen?: Error } = {}) {
  const log: string[] = [], posted: Record<string, unknown>[] = [], opened: { join: ScreenJoin; network: unknown }[] = [];
  let events: Parameters<ReturnType<ScreenViewerTransport>["open"]>[1] | undefined, deliver: ((message: unknown) => void) | undefined;
  const port: ScreenViewerPort = {
    postMessage: message => { posted.push(message); log.push(`post:${String(message.type)}`); },
    start: receive => { deliver = receive; log.push("start"); },
    close: () => log.push("port-close"),
  };
  const transport: ScreenViewerTransport = joined => ({
    open: async (value, handlers) => { opened.push({ join: joined, network: value }); events = handlers; if (rejectOpen) throw rejectOpen; },
    close: () => log.push("channel-close"),
  });
  return { transport, port, log, posted, opened, attach: () => events!.attach(port), fail: (reason: string) => events!.fail(reason), deliver: (message: unknown) => deliver!(message) };
}
/** Opens, attaches and walks the real control handshake up to a live lease. */
async function controllingViewer(inputActive: () => boolean) {
  const f = fakeTransport(), states: ViewerState[] = [], target = canvas();
  const viewer = new RemoteScreenViewer(join, target, state => states.push(state), { transport: f.transport, inputActive });
  await viewer.open(network); f.attach();
  f.deliver(viewing); f.deliver(stream(1)); f.deliver(frame(1, 1)); f.deliver(ready(1, 1));
  // As the Host does: control → new key-frame stream → its frame → the lease.
  viewer.control();
  f.deliver(stream(2)); f.deliver(ready(2, 2)); f.deliver(controlling(2));
  expect(viewer.state).toMatchObject({ controlling: true, fresh: true, pending: false });
  return { f, viewer, states, target };
}

it("an injected transport carries the session exactly as the desktop port does", async () => {
  let active = true;
  const { f, viewer, target } = await controllingViewer(() => active);
  expect(f.opened).toEqual([{ join, network }]);
  expect(f.opened[0]!.join).toBe(join);
  expect(target.focus).toHaveBeenCalledTimes(1);
  // `received` is the only unstamped message; viewer commands carry the session and generation.
  expect(f.posted).toEqual([
    { type: "received", sequence: 1 },
    { type: "control", frameSequence: 1, ...stamp },
    { type: "input-focus", enabled: true, ...stamp },
  ]);
  expect(viewer.input({ kind: "key", code: "KeyA", down: true })).toBe(true);
  expect(f.posted.at(-1)).toEqual({ type: "input", desktopId: session.desktopId, displayId: display.id, displayRevision: display.revision,
    leaseId: lease.id, sequence: 1, frameSequence: 2, expiresAt: expect.any(Number), event: { kind: "key", code: "KeyA", down: true }, ...stamp });
  // The injected check gates input and the focus report like canvas focus does on the desktop.
  active = false;
  const before = f.posted.length;
  expect(viewer.input({ kind: "key", code: "KeyA", down: false })).toBe(false);
  expect(viewer.pointerMove({ clientX: 1, clientY: 1 })).toBe(false);
  expect(f.posted.length).toBe(before);
  f.deliver(controlling(2));
  expect(f.posted.at(-1)).toEqual({ type: "input-focus", enabled: false, ...stamp });
  viewer.dispose();
  expect(f.log.slice(-3)).toEqual(["post:disconnect", "port-close", "channel-close"]);
  viewer.dispose();
  expect(f.log.filter(entry => entry === "channel-close")).toHaveLength(1);
});

it("lease renewal follows the injected input check", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
  let active = false;
  const { f, viewer } = await controllingViewer(() => active);
  vi.advanceTimersByTime(1000);
  expect(f.posted.filter(message => message.type === "renew")).toEqual([]);
  active = true;
  vi.advanceTimersByTime(1000);
  expect(f.posted.filter(message => message.type === "renew")).toEqual([{ type: "renew", leaseId: lease.id, challenge: lease.challenge, frameSequence: 2, ...stamp }]);
  viewer.dispose();
});

it("a transport failure or refused open ends the viewer once and releases the channel", async () => {
  const timeout = fakeTransport(), states: ViewerState[] = [];
  const late = new RemoteScreenViewer(join, canvas(), state => states.push(state), { transport: timeout.transport, inputActive: () => true });
  await late.open(network);
  timeout.fail("screen_connect_timeout");
  expect(states.at(-1)).toMatchObject({ state: "closed", reason: "screen_connect_timeout" });
  // A port that arrives after the viewer ended is closed and never started.
  timeout.attach();
  expect(timeout.log).toEqual(["channel-close", "port-close"]);

  const refused = fakeTransport({ rejectOpen: new Error("screen_viewer_denied") }), refusedStates: ViewerState[] = [];
  const viewer = new RemoteScreenViewer(join, canvas(), state => refusedStates.push(state), { transport: refused.transport, inputActive: () => true });
  await expect(viewer.open(network)).rejects.toThrow("screen_viewer_denied");
  expect(refusedStates.at(-1)).toMatchObject({ state: "closed", reason: "screen_viewer_denied" });
  expect(refused.log).toEqual(["channel-close"]);
});

/** The desktop bridge and window the default (Electron) transport talks to. */
function electronShell() {
  const calls: [string, Record<string, unknown>][] = [];
  const shell = Object.assign(new EventTarget(), { openSuperAgentDesktop: { version: 1, engine: "electron", platform: "darwin", openSocket: async () => {}, on: () => () => {},
    invoke: async (command: string, args: Record<string, unknown>) => { calls.push([command, args]); return command === "screen_viewer_open" ? { sessionId: session.id } : null; } } });
  vi.stubGlobal("window", shell); vi.stubGlobal("location", { origin: "opensuperagent://app" });
  const post = (overrides: Record<string, unknown> = {}, ports: unknown[] = []) => {
    const channelId = calls.find(([command]) => command === "screen_viewer_open")![1].channelId;
    shell.dispatchEvent(Object.assign(new Event("message"), { source: shell, origin: "opensuperagent://app", data: { type: "open-super-agent:screen-port:v1", channelId, sessionId: session.id }, ports, ...overrides }));
  };
  return { calls, post };
}
const nextMessage = (port: MessagePort) => new Promise<Record<string, unknown>>(resolve => { port.onmessage = event => resolve(event.data); });

it("without a transport the viewer uses the Electron main-process port with the same IPC contract", async () => {
  const { calls, post } = electronShell(), states: ViewerState[] = [];
  const viewer = new RemoteScreenViewer(join, canvas(), state => states.push(state), { inputActive: () => true });
  await viewer.open(network);
  expect(calls).toHaveLength(1);
  const [command, args] = calls[0]!;
  expect(command).toBe("screen_viewer_open");
  expect(Object.keys(args)).toEqual(["channelId", "join", "network"]);
  expect(args.join).toBe(join); expect(args.network).toBe(network); expect(args.channelId).toMatch(/^[0-9a-f-]{36}$/);
  const channel = new MessageChannel(), other = new MessageChannel();
  // Only this window, this origin, this channel and session, with exactly one port.
  post({ source: {} }, [other.port2]); post({ origin: "https://example.invalid" }, [other.port2]);
  post({ data: { type: "open-super-agent:screen-port:v1", channelId: "other", sessionId: session.id } }, [other.port2]);
  post({}, [other.port2, channel.port2]); post({}, []);
  post({}, [channel.port2]);
  const sent = nextMessage(channel.port1);
  viewer.release();
  expect(await sent).toEqual({ type: "release", ...stamp });
  const received = new Promise<void>(resolve => { const seen = states.length; const poll = () => states.length > seen ? resolve() : setTimeout(poll, 1); poll(); });
  channel.port1.postMessage(viewing);
  await received;
  expect(viewer.state.state).toBe("viewing");
  const disconnect = nextMessage(channel.port1);
  viewer.dispose();
  expect(await disconnect).toEqual({ type: "disconnect", ...stamp });
  expect(calls.at(-1)).toEqual(["screen_viewer_close", { sessionId: session.id }]);
  channel.port1.close(); other.port1.close(); other.port2.close();
});

it("the Electron port that never arrives times out after ten seconds and closes the session", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
  const { calls } = electronShell(), states: ViewerState[] = [];
  const viewer = new RemoteScreenViewer(join, canvas(), state => states.push(state), { inputActive: () => true });
  await viewer.open(network);
  vi.advanceTimersByTime(9_999);
  expect(states).toEqual([]);
  vi.advanceTimersByTime(1);
  expect(states.at(-1)).toMatchObject({ state: "closed", reason: "screen_connect_timeout" });
  expect(calls.map(([command]) => command)).toEqual(["screen_viewer_open", "screen_viewer_close"]);
  void viewer;
});

it("the default input check is canvas focus in a focused, visible window", () => {
  const target = canvas(), other = canvas();
  const documentWith = (value: Partial<{ focused: boolean; active: unknown; visibility: string }>) => vi.stubGlobal("document",
    { hasFocus: () => value.focused ?? true, activeElement: "active" in value ? value.active : target, visibilityState: value.visibility ?? "visible" });
  documentWith({}); expect(screenCanvasFocused(target)).toBe(true);
  documentWith({ active: other }); expect(screenCanvasFocused(target)).toBe(false);
  documentWith({ focused: false }); expect(screenCanvasFocused(target)).toBe(false);
  documentWith({ visibility: "hidden" }); expect(screenCanvasFocused(target)).toBe(false);
});
