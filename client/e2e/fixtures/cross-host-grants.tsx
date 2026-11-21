import { useReducer, useState } from "react";
import { createRoot } from "react-dom/client";
import { BotMessageGrantsControl } from "../../src/BotMessageGrantsControl.js";
import { CrossHostMessageGrants } from "../../src/CrossHostMessageGrants.js";
import { BotMessageHostsContext, botMessageHostId } from "../../src/bot-message-hosts.js";
import type { ConnectedHost } from "../../src/host-connections.js";
import type { Bot, HubConnection } from "../../src/connection.js";
import type { CrossHostMessageGrantsCommand } from "../../../src/client-protocol/bot-message-grants.js";
import { HubHttpError } from "../../src/http-error.js";
import { setLocale } from "../../src/i18n.js";
import { Capacitor } from "@capacitor/core";
import { NativeBackNavigation } from "../../src/NativeBackNavigation.js";
import { MobileViewport } from "../../src/MobileViewport.js";
import { installFocusIntent } from "../../src/focus-intent.js";
// The App's global stylesheets, in main.tsx order.
import "../../src/styles.css";
import "../../src/brand-theme.css";
import "../../src/palette-tokens.css";
import "../../src/mobile-im.css";
import "../../src/mobile-shell.css";
import "../../src/safe-area.css";
import "../../src/viewport.css";
import "../../src/expressive-themes.css";
import "../../src/layout-density.css";
import "../../src/motion.css";
import "../../src/porcelain-details.css";
import "../../src/ios-adaptive.css";

// Synthetic hosts and Bots only. The receiving Host is a controllable double:
// it records every signed-command payload the page would submit and applies it
// with the same revision check, so tests can assert "no write" as well as the
// exact tuple. Source directories stand in for authenticated App connections.
const query = new URLSearchParams(location.search), english = query.get("lang") === "en";
if (english) setLocale("en");
document.documentElement.dataset.theme = query.get("theme") ?? "light";
document.documentElement.dataset.palette = query.get("palette") ?? "mono";
document.documentElement.dataset.monoAccent = query.get("accent") ?? "warm-gray";
document.documentElement.dataset.platform = query.get("platform") ?? Capacitor.getPlatform();
// `shell=app` adds what main.tsx installs around every page, so this fixture
// can be opened inside the native shell: the production Back listener and
// keyboard-viewport controller then drive the same chooser.
const appShell = query.get("shell") === "app";
if (appShell) { installFocusIntent(); if (Capacitor.getPlatform() === "android") document.documentElement.dataset.nativeInsets = "android"; }
if (query.get("safe")) document.documentElement.style.setProperty("--app-safe-bottom", `${Number(query.get("safe"))}px`);

const publicKey = (seed: string) => btoa(seed.padEnd(32, "."));
const hostId = (seed: string) => botMessageHostId(publicKey(seed));
const revisionText = (value: number) => value.toString(16).padStart(64, "0");
const word = (zh: string, en: string) => english ? en : zh;
const base = { engine: "codex", model: "gpt-6.1-sol", effort: "high", online: 1 } as const;
const sourceBot = (id: string, name: string, extra: Partial<Bot> = {}) => ({ ...base, id, name, ...extra }) as unknown as Bot;

const longName = word("负责跨地区项目资料整理与每周进展汇总的长名称来源助手", "Source assistant for cross-region project archives and weekly progress summaries");
const count = Number(query.get("bots") ?? 8);
const directories: Record<string, Bot[]> = {
  studio: [
    sourceBot("alpha", word("来源研究员", "Source researcher")),
    sourceBot("client_7f3a9c21d4e8b6a05c1f2e93", word("资料助手", "Archive assistant")),
    sourceBot("client_0b8d47e2a9c3f15d6e7a4b20", word("资料助手", "Archive assistant")),
    sourceBot("long_name_bot", longName),
    sourceBot("worker_internal", word("内部执行者", "Internal worker"), { role: "worker" } as Partial<Bot>),
    sourceBot("removed_bot", word("已删除来源助手", "Deleted source assistant"), { deletedAt: 1 } as Partial<Bot>),
    ...Array.from({ length: Math.max(0, count - 4) }, (_, index) => sourceBot(`demo_${String(index + 1).padStart(3, "0")}`, word(`演示助手 ${String(index + 1).padStart(3, "0")}`, `Demo assistant ${String(index + 1).padStart(3, "0")}`))),
  ],
  twin_a: [sourceBot("twin_bot", word("同名主机助手", "Twin host assistant"))],
};
const sources: Record<string, { status: string; bots: Bot[]; dispatchWorkers: Bot[] }> = Object.fromEntries(
  Object.entries(directories).map(([seed, bots]) => [seed, { status: "online", bots, dispatchWorkers: [] }]));
const entries: ConnectedHost[] = Object.entries(sources).map(([seed, state]) => ({
  host: { id: seed, registrationId: seed, name: seed, publicKey: publicKey(seed) },
  connection: { state, isNetworkBlocked: false },
}) as unknown as ConnectedHost);

const targetCount = Number(query.get("targets") ?? 0);
const server = {
  revision: 1,
  host: { id: hostId("receiver"), name: word("演示接收主机", "Demo receiving host") },
  hosts: [
    { id: hostId("studio"), name: word("演示来源主机", "Demo source host"), available: true },
    { id: hostId("lab"), name: word("实验室主机", "Lab host"), available: true },
    { id: hostId("twin_a"), name: word("同名主机", "Twin host"), available: true },
    { id: hostId("twin_b"), name: word("同名主机", "Twin host"), available: true },
    { id: hostId("departed"), name: word("已离网主机", "Departed host"), available: false },
  ],
  bots: [
    { id: "alpha", name: word("研究助手", "Research assistant"), online: true },
    { id: "beta", name: word("复核助手", "Review assistant"), online: false },
    { id: "gamma_long", name: word("负责合同条款逐项核对与风险提示的长名称接收助手", "Receiving assistant for clause-by-clause contract checks and risk notes"), online: true },
    { id: "retired", name: word("已删除助手", "Deleted assistant"), online: false, deleted: true as const },
    ...Array.from({ length: targetCount }, (_, index) => ({ id: `target_${String(index + 1).padStart(3, "0")}`, name: word(`接收助手 ${String(index + 1).padStart(3, "0")}`, `Receiving assistant ${String(index + 1).padStart(3, "0")}`), online: index % 2 === 0 })),
  ] as { id: string; name: string; online: boolean; deleted?: true }[],
  grants: [
    { sourceHost: hostId("studio"), sourceBot: "long_name_bot", targetBot: "beta" },
    { sourceHost: hostId("departed"), sourceBot: "legacy_bot", targetBot: "retired" },
  ],
};
const commands: CrossHostMessageGrantsCommand[] = [];
const control = { failGet: 0, holdPost: false, release: () => {}, gets: 0, receipt: "ok" as "ok" | "lose" | "partial" };
// As on the real Host: a departed source host or a deleted recipient stays in
// the snapshot only while one of its records remains to be revoked.
const snapshot = () => ({ revision: revisionText(server.revision), host: server.host, grants: server.grants,
  hosts: server.hosts.filter(host => host.available || server.grants.some(grant => grant.sourceHost === host.id)),
  bots: server.bots.filter(bot => !bot.deleted || server.grants.some(grant => grant.targetBot === bot.id)) });
const connection = {
  identity: { hubPublicKey: publicKey("receiver") },
  state: { status: "online", bots: [], user: { id: "owner", role: "owner" } },
  subscribe: () => () => {},
  http: async (route: string) => {
    control.gets++;
    if (route === "/api/bot-messages/cross-host-grants") {
      if (control.failGet) { control.failGet--; throw new HubHttpError(503, "unavailable"); }
      return structuredClone(snapshot());
    }
    if (route === "/api/bot-messages/grants") return { revision: revisionText(1), selfTargetSupported: true, bots: server.bots.filter(bot => !bot.deleted).map(({ id, name, online }) => ({ id, name, online })), grants: [] };
    throw new HubHttpError(404, "not_found");
  },
  saveCrossHostMessageGrants: async (command: CrossHostMessageGrantsCommand, _signal: AbortSignal, submitting?: () => void) => {
    submitting?.(); commands.push(structuredClone(command));
    if (control.holdPost) await new Promise<void>(resolve => { control.release = resolve; });
    // The real Host's all-or-nothing checks for one source tuple.
    if (command.revision !== revisionText(server.revision)) throw new HubHttpError(409, "bot_message_grants_changed");
    if (!command.changes.length || command.changes.length > 256 || new Set(command.changes.map(change => change.targetBot)).size !== command.changes.length) throw new HubHttpError(400, "invalid_request");
    if (!server.hosts.some(host => host.id === command.sourceHost)) throw new HubHttpError(404, "bot_message_host_not_found");
    if (command.changes.some(change => change.allowed) && !server.hosts.some(host => host.id === command.sourceHost && host.available)) throw new HubHttpError(403, "bot_message_peer_revoked");
    const has = (targetBot: string) => server.grants.some(grant => grant.sourceHost === command.sourceHost && grant.sourceBot === command.sourceBot && grant.targetBot === targetBot);
    for (const change of command.changes) {
      const bot = server.bots.find(value => value.id === change.targetBot);
      if (!bot || change.allowed && bot.deleted) throw new HubHttpError(410, "bot_deleted");
      if (!change.allowed && !has(change.targetBot)) throw new HubHttpError(409, "bot_message_grant_not_found");
    }
    // `partial`: another writer immediately reverts the batch's first change, so
    // only an every-change readback can notice it. `lose`: committed, receipt lost.
    const applied = control.receipt === "partial" ? command.changes.slice(1) : command.changes;
    for (const change of applied) {
      server.grants = server.grants.filter(grant => !(grant.sourceHost === command.sourceHost && grant.sourceBot === command.sourceBot && grant.targetBot === change.targetBot));
      if (change.allowed) server.grants.push({ sourceHost: command.sourceHost, sourceBot: command.sourceBot, targetBot: change.targetBot });
    }
    server.revision++;
    if (control.receipt === "lose") throw new TypeError("Failed to fetch");
  },
  saveBotMessageGrants: async () => {},
} as unknown as HubConnection;
// Bot settings opens the page for this receiving Bot (`bot=` picks another).
const receiving = server.bots.find(bot => bot.id === (query.get("bot") ?? "alpha"))!;
const receivingBot = { ...base, id: receiving.id, name: receiving.name } as unknown as Bot;

function Fixture() {
  const [, render] = useReducer((value: number) => value + 1, 0);
  const [online, setOnline] = useState(true), [active, setActive] = useState(true), [epoch, setEpoch] = useState(0);
  const [dirty, setDirty] = useState(false), [busy, setBusy] = useState(false);
  Object.assign(window, { grantFixture: {
    server, commands, control, sources, hostId, render,
    setOnline, setActive, remount: () => setEpoch(value => value + 1),
    // Another device or the CLI changed the receiving Host.
    touch: () => { server.revision++; },
    // The next poll comes from the page's own focus listener, not a test hook.
    poll: () => window.dispatchEvent(new Event("focus")),
  } });
  const section = query.get("mount") === "section";
  return <BotMessageHostsContext.Provider value={[...entries]}>
    {appShell && <><NativeBackNavigation/><MobileViewport/></>}
    <main style={{ padding: 16, minHeight: "100dvh", background: "var(--bg)", color: "var(--text)" }}>
      <h1 style={{ fontSize: 16 }}>{word("演示工作区", "Demo workspace")}</h1>
      <output data-testid="page-state" hidden>{JSON.stringify({ dirty, busy })}</output>
      {section ? <section className="settings-content" hidden={!active} style={{ maxWidth: 640, margin: "16px auto" }}>
        <CrossHostMessageGrants key={epoch} connection={connection} active={active} online={online} onDirty={setDirty} onBusy={setBusy}/>
      </section> : <div style={{ maxWidth: 420, marginTop: 16 }}><BotMessageGrantsControl connection={connection} bot={receivingBot} online={online} owner/></div>}
    </main>
  </BotMessageHostsContext.Provider>;
}
createRoot(document.getElementById("root")!).render(<Fixture/>);
