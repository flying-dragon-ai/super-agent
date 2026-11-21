import { useEffect, useRef, useState } from "react";
import type { PiSessionCommand } from "../../src/client-protocol/pi-commands.js";
import { ChevronDown, Cpu } from "lucide-react";
import { piSessionResultSchema, piSessionSnapshotSchema, type PiSessionChange, type PiSessionSnapshot } from "../../src/client-protocol/pi-session.js";
import type { Bot, HubConnection } from "./connection.js";
import { CreationDialog } from "./CreationDialog.js";
import { PiModelSelect } from "./PiModelSelect.js";
import { modelOptions } from "./model-selection.js";
import { queueRequest } from "./prompt-queue-request.js";
import { randomNonce } from "./identity.js";
import { t, useLocale } from "./i18n.js";
import "./composer-model-controls.css";
import "./pi-session-controls.css";

// A lost response retains the same request ID across closing/reopening the UI.
// Checking it again must not issue a second model change.
const pending = new WeakMap<HubConnection, Map<string, PiSessionChange>>();
function pendingFor(connection: HubConnection) {
  let store = pending.get(connection);
  if (!store) { store = new Map(); pending.set(connection, store); }
  return store;
}

/** Native conversation controls. Reading this panel cannot start a Pi worker. */
export function PiSessionControls({ connection, conversationId, bot, owner, online, active, activity, onCommands }: {
  connection: HubConnection; conversationId: string; bot: Bot; owner: boolean; online: boolean; active: boolean; activity: string;
  onCommands?: (conversationId: string, botId: string, commands: PiSessionCommand[]) => void;
}) {
  useLocale();
  const [open, setOpen] = useState(false), [snapshot, setSnapshot] = useState<PiSessionSnapshot>();
  const [stale, setStale] = useState(false), [reading, setReading] = useState(false), [saving, setSaving] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [refresh, setRefresh] = useState(0);
  const [model, setModel] = useState(""), [thinking, setThinking] = useState("");
  const [search, setSearch] = useState("");
  const trigger = useRef<HTMLButtonElement>(null), alive = useRef(true), writeFlight = useRef(false);
  const observed = useRef<{ token?: string; model?: string; thinking?: string }>({});
  const draftRev = useRef({ model: 0, thinking: 0 }), syncedRev = useRef({ model: 0, thinking: 0 });
  const acceptedSync = useRef<{ model?: number; thinking?: number }>({});
  const editModel = (next: string) => { draftRev.current.model++; setModel(next); };
  const editThinking = (next: string) => { draftRev.current.thinking++; setThinking(next); };
  const scope = `${conversationId}:${bot.id}`, route = `/api/conversations/${conversationId}/pi-session`;
  const uncertain = pendingFor(connection).has(scope);
  const session = snapshot?.session;
  useEffect(() => {
    onCommands?.(conversationId, bot.id, active && owner && online && !stale ? session?.commands ?? [] : []);
    return () => onCommands?.(conversationId, bot.id, []);
  }, [onCommands, conversationId, bot.id, active, owner, online, stale, session?.commands]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { if (!active || !owner) setOpen(false); }, [active, owner]);
  useEffect(() => {
    if (!active || !owner || !online || saving) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      const request = queueRequest([controller.signal], 10_000);
      setReading(true);
      try {
        const value = piSessionSnapshotSchema.parse(await request.wait(connection.http(`${route}?botId=${encodeURIComponent(bot.id)}`, { signal: request.signal })));
        if (!controller.signal.aborted) {
          const waiting = pendingFor(connection).get(scope);
          // A different exact worker cannot receive the old operation. Merely
          // reading its current value is NOT proof a timed-out write has settled.
          if (waiting && value.session && waiting.expectedSession !== value.session.token && pendingFor(connection).get(scope) === waiting) {
            pendingFor(connection).delete(scope); setError(""); setNotice("");
          }
          // Do not erase an unsaved selection on every metadata poll. Rebase a
          // field on a new worker generation, an observed change while clean, or
          // after its own accepted save when no newer local edit occurred.
          const prev = observed.current, next = value.session, tokenChanged = next?.token !== prev.token;
          const acceptModel = acceptedSync.current.model, acceptThinking = acceptedSync.current.thinking;
          acceptedSync.current.model = undefined; acceptedSync.current.thinking = undefined;
          if (tokenChanged || (acceptModel !== undefined && draftRev.current.model === acceptModel) || (next?.model !== prev.model && draftRev.current.model === syncedRev.current.model)) {
            setModel(next?.model ?? ""); syncedRev.current.model = draftRev.current.model;
          }
          if (tokenChanged || (acceptThinking !== undefined && draftRev.current.thinking === acceptThinking) || (next?.thinking !== prev.thinking && draftRev.current.thinking === syncedRev.current.thinking)) {
            setThinking(next?.thinking ?? ""); syncedRev.current.thinking = draftRev.current.thinking;
          }
          observed.current = { token: next?.token, model: next?.model, thinking: next?.thinking };
          setSnapshot(value); setStale(false);
        }
      } catch { if (!controller.signal.aborted) setStale(true); }
      finally {
        request.dispose();
        if (!controller.signal.aborted) {
          setReading(false);
          if (open) timer = setTimeout(() => void read(), 5000);
        }
      }
    };
    void read(); return () => { controller.abort(); clearTimeout(timer); };
  }, [connection, route, bot.id, owner, active, online, open, activity, refresh, saving]);

  async function submit(command: PiSessionChange) {
    if (writeFlight.current || !owner || !online || !active) return;
    const checkingExisting = pendingFor(connection).get(scope)?.requestId === command.requestId;
    const editRev = draftRev.current[command.action];
    writeFlight.current = true; pendingFor(connection).set(scope, command);
    setSaving(true); setError(""); setNotice("");
    const request = queueRequest([], 15_000);
    try {
      const result = piSessionResultSchema.parse(await request.wait(connection.http(route, { method: "POST", body: JSON.stringify(command), signal: request.signal })));
      // An older component can finish after reopening and submitting a newer
      // operation. Its receipt must never erase that newer pending operation.
      // A rejected status on a CHECK can describe this check's lost permission
      // or disconnected worker, not the already admitted original operation.
      const settled = result.outcome === "accepted" || !checkingExisting && result.outcome === "rejected";
      if (settled && pendingFor(connection).get(scope)?.requestId === command.requestId) pendingFor(connection).delete(scope);
      if (alive.current) {
        if (result.outcome === "accepted") { acceptedSync.current[command.action] = editRev; setNotice(t("已应用到当前 Pi 对话。")); }
        else setError(!settled ? t("结果尚未确认，请核对后再修改。")
          : result.reason === "invalid"
            ? (command.value === null
              ? (command.action === "thinking"
                ? t("Bot 默认思考强度不适用于当前对话模型。请选择可用档位，或调整 Bot 默认设置后重试。")
                : t("Bot 默认模型或 Pi 默认模型当前不可用。请选择可用模型，或检查提供商登录与 Bot 默认设置后重试。"))
              : t("当前模型不支持这个选择，请重新读取。"))
            : t("Pi 会话已变化或暂不可用，请重新读取。"));
      }
    } catch { if (alive.current) setError(t("结果尚未确认，请核对后再修改。")); }
    finally {
      request.dispose(); writeFlight.current = false;
      if (alive.current) { setSaving(false); setRefresh(value => value + 1); }
    }
  }
  function change(action: "model" | "thinking", value: string | null) {
    if (!session || stale || reading || saving || uncertain) return;
    void submit({ botId: bot.id, requestId: randomNonce(), expectedSession: session.token, action, value });
  }
  const choices = modelOptions("pi", session?.choices ?? []);
  const query = search.trim().toLocaleLowerCase();
  const filtered = query ? choices.filter(option => `${option.label} ${option.id} ${option.provider ?? ""}`.toLocaleLowerCase().includes(query)) : choices;
  const blocked = !online || stale || reading || saving || uncertain;
  const displayModel = choices.find(option => option.id === session?.model)?.label || session?.model || t("当前对话");
  return <div className="composer-model-controls pi-session-controls">
    <button ref={trigger} type="button" className="composer-model-trigger" aria-label={t("Pi 对话设置")} aria-haspopup="dialog" aria-expanded={open} disabled={!owner || !online} title={t("调整当前 Pi 对话的模型与思考强度")} onClick={() => { setOpen(true); setRefresh(value => value + 1); }}><Cpu size={13} aria-hidden="true"/><span>Pi · {displayModel}</span><ChevronDown size={12} aria-hidden="true"/></button>
    {open && owner && <CreationDialog mobilePage title={t("Pi 对话设置")} closeLabel={t("关闭 Pi 对话设置")} close={() => setOpen(false)} busy={saving} returnFocus={trigger}>
      <div className="pi-session-panel">
        <p className="muted">{t("仅调整当前对话；运行中修改会用于后续模型调用，不改变 Bot 默认设置。")}</p>
        {!session && <p role="status">{stale ? t("暂未读取到 Pi 会话，请重新读取。") : reading ? t("正在读取…") : snapshot?.supported === false ? t("请更新主机以使用此设置。") : t("当前没有正在运行的 Pi 会话。发送一条消息后即可在这里调整。")}</p>}
        {session && <>
          <label>{t("搜索模型")}<input type="search" value={search} onChange={event => setSearch(event.target.value)} disabled={saving} autoCapitalize="none" autoCorrect="off"/></label>
          <PiModelSelect models={filtered} value={model} change={editModel} disabled={blocked} defaultLabel={t("跟随 Bot 默认")} searching={!!query}/>
          <button className="primary" type="button" disabled={blocked || !!model && !choices.some(option => option.id === model) || model === session.model} onClick={() => change("model", model || null)}>{t("应用模型")}</button>
          <label>{t("思考强度")}<select aria-label={t("Pi 对话思考强度")} disabled={blocked} value={thinking} onChange={event => editThinking(event.target.value)}><option value="">{t("跟随 Bot 默认")}</option>{session.thinkingLevels.map(level => <option key={level} value={level}>{level}</option>)}</select></label>
          {!thinking && !bot.effort && <p className="muted">{t("Bot 未设置默认思考强度；清除对话覆盖后，当前档位保持不变。")}</p>}
          <button className="primary" type="button" disabled={blocked || thinking === session.thinking || !!thinking && !session.thinkingLevels.includes(thinking as typeof session.thinking)} onClick={() => change("thinking", thinking || null)}>{t("应用思考强度")}</button>
          {session.bridge === "unavailable" && <p className="settings-warning" role="status">{t("Pi 扩展连接暂不可用，App 工具需要恢复连接后使用。")}</p>}
          {(session.ui.title || Object.keys(session.ui.status).length > 0 || Object.keys(session.ui.widgets).length > 0) && <section className="pi-extension-output" aria-label={t("Pi 扩展信息")}>
            <h3>{t("Pi 扩展信息")}</h3>{session.ui.title && <p>{session.ui.title}</p>}
            {Object.entries(session.ui.status).map(([key, text]) => <p key={key}>{text}</p>)}
            {Object.entries(session.ui.widgets).map(([key, widget]) => <pre key={key}>{widget.lines.join("\n")}</pre>)}
          </section>}
        </>}
        {stale && session && <p className="settings-warning" role="status">{t("Pi 会话状态未确认，请重新读取后再修改。")}</p>}
        {notice && <p role="status">{notice}</p>}{error && <p className="settings-warning" role="alert">{error}</p>}
        {uncertain && <p className="muted">{t("上次修改仍可能生效。若核对后仍无结果，请在任务结束后重启 Bot，再重新读取；不会自动重复修改。")}</p>}
        {uncertain ? <button type="button" disabled={saving || !online} onClick={() => { const command = pendingFor(connection).get(scope); if (command) void submit(command); }}>{t("核对修改结果")}</button> : <button type="button" disabled={reading || saving || !online} onClick={() => { setError(""); setRefresh(value => value + 1); }}>{t("重新读取")}</button>}
      </div>
    </CreationDialog>}
  </div>;
}
