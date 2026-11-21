import { useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ArrowUpRight, Check, RefreshCw, Search, ShieldCheck } from "lucide-react";
import { idSchema } from "../../src/client-protocol/index.js";
import { crossHostMessageGrantsSnapshotSchema, type CrossHostMessageGrantsSnapshot, type CrossHostMessageGrantsCommand } from "../../src/client-protocol/bot-message-grants.js";
import type { HubConnection } from "./connection.js";
import { Avatar } from "./Avatar.js";
import { BotMessageHostsContext, isInternalMessageSource, messageSourceBots } from "./bot-message-hosts.js";
import { HubHttpError } from "./http-error.js";
import { t } from "./i18n.js";

const route = "/api/bot-messages/cross-host-grants";
type Edge = { sourceHost: string; sourceBot: string; targetBot: string };
const same = (a: Edge, b: Edge) => a.sourceHost === b.sourceHost && a.sourceBot === b.sourceBot && a.targetBot === b.targetBot;
const allowed = (view: CrossHostMessageGrantsSnapshot, edge: Edge) => view.grants.some(grant => same(grant, edge));
function errorText(error: unknown): string {
  if (error instanceof HubHttpError) {
    if (["device_action_expired", "device_action_invalid"].includes(error.code)) return t("设备验证已失效，请重新载入后重试。");
    if (["bot_message_peer_revoked", "network_not_joined", "network_host_removed", "bot_message_host_not_found"].includes(error.code)) return t("授权、Bot 或网络状态已变化，请重新载入后核对。");
    if (error.status === 404 && error.code === "not_found") return t("请更新接收主机后使用跨主机消息授权。");
    if (error.status === 401 || error.status === 403) return t("只有已认证的接收主机所有者可以管理跨主机授权。");
    if (error.status === 409 || error.status === 410) return t("授权、Bot 或网络状态已变化，请重新载入后核对。");
  }
  return t("无法核对主机权限，请恢复连接后重试。");
}

/** The Local page's layout with one more choice: the source host. A draft
 * (`edits`) holds only differences from the receiving Host's snapshot for the
 * chosen source tuple, which can't change while a draft exists; one save is
 * one atomic command for that tuple. The receiving Host remains the authority. */
export function CrossHostMessageGrants({ connection, initialBotId, active, online, onDirty, onBusy }: {
  connection: HubConnection; initialBotId?: string; active: boolean; online: boolean;
  onDirty: (value: boolean) => void; onBusy: (value: boolean) => void;
}) {
  const entries = useContext(BotMessageHostsContext);
  const [view, setView] = useState<CrossHostMessageGrantsSnapshot>();
  // The source tuple only selects what is shown; changing it is not an edit.
  const [sourceHost, setSourceHost] = useState(""), [sourceBot, setSourceBot] = useState(""), [manual, setManual] = useState(false);
  const [edits, setEdits] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false), [checking, setChecking] = useState(false);
  const [stale, setStale] = useState(false), [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [query, setQuery] = useState(""), [recordQuery, setRecordQuery] = useState("");
  const mounted = useRef(true), generation = useRef(0), writing = useRef(false), reading = useRef(false), manualRead = useRef(false);
  const request = useRef<AbortController | undefined>(undefined), current = useRef(view), draft = useRef(edits);
  const failedWrite = useRef(false), unknownWrite = useRef(false), feedback = useRef<HTMLDivElement>(null);
  const focusAfter = useRef(false), focusBefore = useRef<Element | null>(null);
  const idField = useRef<HTMLInputElement>(null), focusIdField = useRef(false), titleId = useId();
  const selection = useRef(sourceHost);
  const dirty = Object.keys(edits).length > 0;
  selection.current = sourceHost; current.current = view; draft.current = edits;
  // Parent navigation must see the current draft/write before the next input.
  useLayoutEffect(() => { onDirty(dirty || uncertain); }, [dirty, uncertain, onDirty]);
  useLayoutEffect(() => { onBusy(busy); }, [busy, onBusy]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; request.current?.abort(); }; }, []);
  useEffect(() => {
    if (busy || checking || !focusAfter.current) return;
    focusAfter.current = false;
    if (document.activeElement === document.body || document.activeElement === focusBefore.current) feedback.current?.focus({ preventScroll: true });
  }, [busy, checking, error, notice]);
  useEffect(() => { if (manual && focusIdField.current) { focusIdField.current = false; idField.current?.focus(); } }, [manual]);
  const adopt = useCallback((fresh: CrossHostMessageGrantsSnapshot) => {
    current.current = fresh; draft.current = {}; setView(fresh); setEdits({}); setStale(false); setUncertain(false);
    const oldHost = selection.current;
    const nextHost = fresh.hosts.some(host => host.id === oldHost && host.available) ? oldHost : fresh.hosts.find(host => host.available)?.id ?? "";
    if (nextHost !== oldHost) { setSourceHost(nextHost); setSourceBot(""); setManual(false); }
  }, []);
  const refresh = useCallback(async (discard = false, explicit = false) => {
    if (writing.current || reading.current && (!explicit || manualRead.current) || !online) return;
    manualRead.current = explicit;
    reading.current = true; const epoch = ++generation.current;
    const controller = new AbortController(); request.current?.abort(); request.current = controller;
    const timeout = setTimeout(() => controller.abort(), 15_000);
    if (explicit) { setChecking(true); focusBefore.current = document.activeElement; focusAfter.current = true; }
    try {
      const fresh = crossHostMessageGrantsSnapshotSchema.parse(await connection.http(route, { signal: controller.signal }));
      if (!mounted.current || generation.current !== epoch) return;
      if (discard) { failedWrite.current = false; unknownWrite.current = false; setError(""); adopt(fresh); setNotice(t("已重新载入主机当前权限。")); }
      // A GET is not a write receipt. An explicit recheck may clear a known
      // rejection; an unknown outcome is cleared only by discarding.
      else if (!failedWrite.current || explicit && !unknownWrite.current) {
        failedWrite.current = false; setError("");
        if (fresh.revision !== current.current?.revision) setNotice("");
        if (!Object.keys(draft.current).length) adopt(fresh);
        else { setStale(fresh.revision !== current.current?.revision); setView(old => old ? { ...old, hosts: fresh.hosts, bots: fresh.bots } : fresh); }
      }
    } catch (failure) {
      if (mounted.current && generation.current === epoch && !unknownWrite.current) { setError(errorText(failure)); setNotice(""); }
    } finally {
      clearTimeout(timeout);
      if (generation.current === epoch) { reading.current = false; manualRead.current = false; if (mounted.current) setChecking(false); }
    }
  }, [adopt, connection, online]);
  useEffect(() => {
    if (!active || !online) return;
    void refresh();
    const visible = () => { if (document.visibilityState === "visible") void refresh(); };
    const timer = setInterval(visible, 5_000);
    window.addEventListener("focus", visible); document.addEventListener("visibilitychange", visible);
    return () => { clearInterval(timer); window.removeEventListener("focus", visible); document.removeEventListener("visibilitychange", visible); };
  }, [active, online, refresh]);

  const label = (items: { id: string; name: string }[], id: string) => {
    const item = items.find(value => value.id === id);
    return item ? items.filter(value => value.name === item.name).length > 1 ? `${item.name} · …${id.slice(-6)}` : item.name : id;
  };
  const hostName = (id: string) => label(view?.hosts ?? [], id);
  const targetName = (id: string) => label(view?.bots ?? [], id);
  // Source names come from an authenticated connection to that host, never
  // from this host's Bots: a remote ID gets no local avatar or presence.
  const sourceName = (host: string, bot: string) => label(messageSourceBots(entries, host), bot);
  const edgeParts = (edge: Edge) => [`${hostName(edge.sourceHost)} · ${sourceName(edge.sourceHost, edge.sourceBot)}`, `${view?.host.name ?? ""} · ${targetName(edge.targetBot)}`] as const;
  const edgeText = (edge: Edge) => edgeParts(edge).join(" → ");
  const available = (id: string) => !!view?.hosts.some(host => host.id === id && host.available);
  const live = (id: string) => !!view?.bots.some(bot => bot.id === id && !bot.deleted);
  const internal = (edge: Pick<Edge, "sourceHost" | "sourceBot">) => isInternalMessageSource(entries, edge.sourceHost, edge.sourceBot);
  const revokeOnly = (edge: Edge) => !available(edge.sourceHost) || !live(edge.targetBot) || internal(edge);

  const sources = messageSourceBots(entries, sourceHost);
  // Sources that already hold an editable grant here stay selectable by ID
  // even when this App has no connection to their host.
  const recorded = view?.grants.filter(grant => grant.sourceHost === sourceHost && !revokeOnly(grant)) ?? [];
  const listed = [...new Set([...sources.map(bot => bot.id), ...recorded.map(grant => grant.sourceBot)])];
  const byId = manual || !listed.length;
  const source = sourceBot.trim();
  const choices = source && !listed.includes(source) ? [...listed, source] : listed;
  const validSource = idSchema.safeParse(source).success;
  const liveSource = sources.some(bot => bot.id === source);
  const internalSource = validSource && internal({ sourceHost, sourceBot: source });
  // New grants follow the existing rules: a live named source, or an exact ID
  // when no directory is connected or the owner chose to type one.
  const canGrant = available(sourceHost) && validSource && !internalSource && (manual || !sources.length || liveSource);
  const firstChoice = listed[0] ?? "";
  useEffect(() => { if (!dirty && !manual && !sourceBot && firstChoice) setSourceBot(firstChoice); }, [dirty, manual, sourceBot, firstChoice]);

  const targets = view?.bots.filter(bot => !bot.deleted) ?? [];
  // Bot settings opens this page for one receiving Bot: list it first. It is
  // never a choice or an edit by itself.
  const ordered = targets.some(bot => bot.id === initialBotId) ? [...targets.filter(bot => bot.id === initialBotId), ...targets.filter(bot => bot.id !== initialBotId)] : targets;
  const existing = (targetBot: string) => !!view && validSource && allowed(view, { sourceHost, sourceBot: source, targetBot });
  const checked = (targetBot: string) => edits[targetBot] ?? existing(targetBot);
  const visible = ordered.filter(bot => targetName(bot.id).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const selectedCount = targets.filter(bot => checked(bot.id)).length;
  const changes = Object.entries(edits).map(([targetBot, allow]) => ({ targetBot, allowed: allow }));
  const locked = busy || checking || !online || stale || uncertain;
  const blocked = locked || !!error;
  const canSave = !!view && dirty && !blocked && changes.length <= 256 && validSource && view.hosts.some(host => host.id === sourceHost)
    && changes.every(change => !change.allowed || canGrant && live(change.targetBot));
  const toggle = (targetBot: string, value: boolean) => {
    if (!current.current || writing.current) return;
    const next = { ...draft.current };
    if (value === existing(targetBot)) delete next[targetBot]; else next[targetBot] = value;
    draft.current = next; setEdits(next); setNotice("");
  };
  const chooseHost = (id: string) => {
    if (Object.keys(draft.current).length || !current.current?.hosts.some(host => host.id === id && host.available)) return;
    setSourceHost(id); setSourceBot(""); setManual(false); setNotice("");
  };
  const toggleManual = () => {
    if (Object.keys(draft.current).length) return;
    focusIdField.current = !manual; setManual(!manual); setSourceBot(""); setNotice("");
  };

  const commit = async (command: CrossHostMessageGrantsCommand, success: string) => {
    if (!current.current || writing.current || manualRead.current) return;
    writing.current = true; const epoch = ++generation.current; request.current?.abort(); reading.current = false;
    const controller = new AbortController(); request.current = controller; const timeout = setTimeout(() => controller.abort(), 30_000);
    focusBefore.current = document.activeElement; focusAfter.current = true; setBusy(true); setChecking(false); setError(""); setNotice("");
    let submitted = false, confirmed = false;
    try {
      await connection.saveCrossHostMessageGrants(command, controller.signal, () => { submitted = true; }); confirmed = true;
      const fresh = crossHostMessageGrantsSnapshotSchema.parse(await connection.http(route, { signal: controller.signal }));
      if (!mounted.current || generation.current !== epoch) return;
      // Every change in the batch must read back as written; a partial result is not a save.
      const verified = command.changes.every(change => allowed(fresh, { sourceHost: command.sourceHost, sourceBot: command.sourceBot, targetBot: change.targetBot }) === change.allowed
        && (!change.allowed || fresh.hosts.some(host => host.id === command.sourceHost && host.available) && fresh.bots.some(bot => bot.id === change.targetBot && !bot.deleted)));
      if (!verified) { failedWrite.current = true; setStale(true); setError(t("授权又发生了变化，请重新载入后核对。")); }
      else { failedWrite.current = false; unknownWrite.current = false; adopt(fresh); setNotice(success); }
    } catch (failure) {
      if (!mounted.current || generation.current !== epoch) return;
      failedWrite.current = true;
      const unknown = confirmed || submitted && (!(failure instanceof HubHttpError) || failure.code === "device_action_cancelled" || failure.status < 400 || failure.status >= 500 || failure.status === 408);
      unknownWrite.current = unknown; setUncertain(unknown); setStale(!unknown && failure instanceof HubHttpError && [409, 410].includes(failure.status));
      setError(unknown ? t("尚未确认保存结果。请重新载入并核对，系统不会自动重复提交授权。") : errorText(failure));
    } finally { clearTimeout(timeout); writing.current = false; if (mounted.current && generation.current === epoch) setBusy(false); }
  };
  const save = () => {
    if (!view || !canSave) return;
    void commit({ operation: "cross-host-message-grants", sourceHost, sourceBot: source, revision: view.revision, changes }, t("已保存授权，并从接收主机核对生效。"));
  };
  const revoke = (edge: Edge) => {
    const snapshot = current.current;
    if (!snapshot || blocked || Object.keys(draft.current).length || !allowed(snapshot, edge)) return;
    void commit({ operation: "cross-host-message-grants", sourceHost: edge.sourceHost, sourceBot: edge.sourceBot, revision: snapshot.revision,
      changes: [{ targetBot: edge.targetBot, allowed: false }] }, t("已撤销授权，并从接收主机核对生效。"));
  };

  const hosts = view?.hosts.filter(host => host.available || host.id === sourceHost) ?? [];
  const formShown = !!view && view.hosts.some(host => host.available);
  const records = view?.grants.filter(revokeOnly) ?? [];
  const shownRecords = records.filter(edge => edgeText(edge).toLocaleLowerCase().includes(recordQuery.trim().toLocaleLowerCase()));
  const direction = (edge: Edge) => { const [from, to] = edgeParts(edge); return <><span>{from}</span>{" "}<span>→ {to}</span></>; };
  // One unsaved-changes mark for the pair, as the Local page has for its one select.
  const sourceTitle = (text: string, mark = false) => <span className="message-grants-source-title"><span>{text}</span>{mark && dirty && <small>{t("有未保存的修改")}</small>}</span>;
  const sourceLock = dirty ? t("保存或放弃修改后，可以切换发送方。") : undefined;
  const reload = <button type="button" className="secondary" disabled={busy || checking || !online} onClick={() => { void refresh(true, true); }}>{checking ? t("正在载入…") : t("重新载入并核对")}</button>;
  return <div className="cross-host-message-grants">
    <div className="message-grants-intro"><p>{t("允许其他主机的指定 Bot 向这台主机发送协作消息与文件。")}</p>
      <button type="button" className="icon-button" aria-label={t("刷新跨主机授权")} aria-busy={checking} disabled={busy || checking || !online} onClick={() => { void refresh(false, true); }}><RefreshCw size={17} className={checking ? "is-loading" : ""}/></button></div>
    {view && <p className="cross-grants-receiver"><ShieldCheck size={16}/>{t("接收主机：{0}", view.host.name)}</p>}
    {!online && <p role="status">{t("连接恢复后即可操作")}</p>}
    {!view && !error && online && <p role="status">{t("正在读取主机授权…")}</p>}
    {view && (!formShown ? <>
      <p className="empty-state">{t("暂无可授权的其他主机。请先在「设备与网络」中将两台主机加入同一网络。")}</p>
      {(stale || uncertain || error) && <div className="message-grants-actions">{reload}</div>}
    </> : <>
      <label className="message-grants-source">{sourceTitle(t("发送方电脑"), true)}
        <select aria-label={t("发送方电脑")} title={sourceLock} value={sourceHost} disabled={busy || checking || dirty} onChange={event => chooseHost(event.target.value)}>
          {hosts.map(host => <option key={host.id} value={host.id}>{host.available ? hostName(host.id) : `${hostName(host.id)} · ${t("不可用")}`}</option>)}
        </select></label>
      {byId ? <label className="message-grants-source">{sourceTitle(t("发送方 Bot ID"))}
          <input ref={idField} aria-label={t("发送方 Bot ID")} title={sourceLock} autoComplete="off" autoCapitalize="off" spellCheck={false} maxLength={128} value={sourceBot} disabled={busy || checking || dirty} onChange={event => { setSourceBot(event.target.value); setNotice(""); }}/></label>
        : <label className="message-grants-source">{sourceTitle(t("发送方 Bot"))}
          <select aria-label={t("发送方 Bot")} title={sourceLock} value={source} disabled={busy || checking || dirty} onChange={event => { if (!Object.keys(draft.current).length) { setSourceBot(event.target.value); setNotice(""); } }}>
            {choices.map(id => { const count = recorded.filter(grant => grant.sourceBot === id).length, text = sourceName(sourceHost, id);
              return <option key={id} value={id}>{count ? t("{0} · 已授权 {1} 个", text, count) : text}</option>; })}
          </select></label>}
      {!sources.length && <p className="message-grants-hint">{t("此设备尚未连接发送方电脑，或发送方电脑暂时离线。连接后可按名称选择；也可填写准确的 Bot ID。")}</p>}
      {(manual || !sources.length) && validSource && !internalSource && <p className="message-grants-hint">{t("请核对发送方 Bot ID；这里不会自动验证它的名称或创建新 Bot。")}</p>}
      {internalSource && <p role="alert" className="message-grants-error">{t("内部执行者不参与手动消息授权，请选择普通 Bot。")}</p>}
      {!manual && !!sources.length && validSource && !liveSource && !internalSource && <p className="message-grants-hint">{t("这个 Bot 不在发送方电脑当前列表中，只能撤销已有授权。")}</p>}
      <details className="cross-grants-more"><summary>{t("说明与手动 Bot ID")}</summary>
        <p className="message-grants-hint">{t("由接收主机的所有者确认。仅授权所选方向；原任务的结果回复无需反向授权。")}</p>
        <p className="message-grants-hint">{t("授权允许列出接收 Bot 的对话名称、发送消息与文件；只可取回自身任务的回复。")}</p>
        {listed.length > 0 && <button type="button" className="text-button" title={sourceLock} disabled={busy || checking || dirty} onClick={toggleManual}>{manual ? t("从列表选择 Bot") : t("使用 Bot ID")}</button>}
      </details>
      <div className="message-grants-heading"><h4 id={titleId}><ArrowUpRight size={17}/>{t("允许联系的本机 Bot")}</h4><span>{t("已选择 {0} 个", selectedCount)}</span></div>
      <p className="message-grants-hint">{t("只设置这个方向；接收方可以返回原任务结果，无需反向授权。")}</p>
      {targets.length > 6 && <label className="message-grants-search"><Search size={16}/><input aria-label={t("查找接收方 Bot")} placeholder={t("查找接收方 Bot")} value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === "Escape" && query) { event.preventDefault(); event.stopPropagation(); setQuery(""); } }}/></label>}
      <div className="message-grants-targets" role="group" aria-labelledby={titleId}>
        {visible.slice(0, 100).map(bot => <label className="message-grants-target" key={bot.id} data-bot-id={bot.id}>
          <Avatar kind="bot" id={bot.id} name={bot.name} size={30}/>
          <span className="message-grants-target-name"><strong>{targetName(bot.id)}</strong><small id={`${titleId}-${bot.id}`}><i data-online={bot.online}/>{bot.online ? t("当前在线") : t("当前离线")}</small></span>
          <input type="checkbox" aria-describedby={`${titleId}-${bot.id}`} aria-label={t("允许 {0} → {1}", `${hostName(sourceHost)} · ${sourceName(sourceHost, source)}`, targetName(bot.id))}
            checked={checked(bot.id)} disabled={locked || !(existing(bot.id) || bot.id in edits || canGrant)} onChange={event => toggle(bot.id, event.target.checked)}/>
        </label>)}
        {!targets.length && <p>{t("主机还没有 Bot。创建 Bot 后即可在这里授权。")}</p>}
        {!!targets.length && !visible.length && <p className="message-grants-hint">{t("没有找到匹配的 Bot。")}</p>}
        {visible.length > 100 && <p>{t("仅显示前 100 个，请搜索缩小范围。")}</p>}
      </div>
      {changes.some(change => !change.allowed) && <p className="message-grants-caution">{t("取消授权将阻止后续发送和结果查询，但不会停止或取消已提交的任务。建议取回结果后再取消授权。")}</p>}
      {changes.length > 256 && <p role="alert">{t("一次最多修改 256 个接收方，请减少本次修改后保存。")}</p>}
      <div className="message-grants-actions">
        <button type="button" className="secondary" disabled={busy || checking || !online || (!dirty && !stale && !uncertain && !error)} onClick={() => { void refresh(stale || uncertain || !error, true); }}>{checking ? t("正在载入…") : stale || uncertain ? t("重新载入并核对") : error ? t("重新核对") : t("放弃修改")}</button>
        <button type="button" className="primary" disabled={!canSave} onClick={save}>{busy ? t("正在保存并核对…") : t("保存授权")}</button>
      </div>
    </>)}
    {view && records.length > 0 && <section className="cross-grants-unavailable"><h4>{t("仅可撤销的授权")}</h4>
      <p className="message-grants-hint">{t("包含通过命令行设置的授权。主机离网后授权不会放行，仍可在此撤销记录。")}</p>
      {records.length > 6 && <label className="message-grants-search"><Search size={16} aria-hidden="true"/><input aria-label={t("查找跨主机授权")} placeholder={t("查找跨主机授权")} value={recordQuery} onChange={event => setRecordQuery(event.target.value)}/></label>}
      {shownRecords.slice(0, 100).map(edge => <div className="cross-grants-edge" key={JSON.stringify(edge)}><div><strong>{direction(edge)}</strong>
        {!available(edge.sourceHost) && <small>{t("发送方电脑当前不可用，仅可撤销")}</small>}
        {!live(edge.targetBot) && <small>{t("接收 Bot 已不可用，仅可撤销")}</small>}
        {internal(edge) && <small>{t("来源为内部执行者，仅可撤销")}</small>}</div>
        <button type="button" className="text-danger" disabled={blocked || dirty} onClick={() => revoke(edge)} aria-label={t("撤销 {0}", edgeText(edge))}>{t("撤销授权")}</button></div>)}
      {!shownRecords.length && <p className="message-grants-hint">{t("暂无匹配的跨主机授权。")}</p>}
      {shownRecords.length > 100 && <p>{t("仅显示前 100 个，请搜索缩小范围。")}</p>}
    </section>}
    {(error || stale || notice) && <div ref={feedback} tabIndex={-1} className="message-grants-feedback cross-grants-feedback" role="group" aria-label={t("跨主机授权状态")}>
      {error && <p role="alert" className="message-grants-error">{error}</p>}
      {stale && !error && <p role="alert" className="message-grants-error">{t("授权、Bot 或网络状态已变化，请重新载入后核对。")}</p>}
      {notice && !error && !stale && <p role="status" className="message-grants-notice"><Check size={15}/>{notice}</p>}
    </div>}
    {!view && error && reload}
  </div>;
}
