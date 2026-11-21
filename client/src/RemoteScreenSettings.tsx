import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import type { ScreenStatus, ScreenPolicy } from "../../src/client-protocol/remote-screen.js";
import type { HubConnection } from "./connection.js";
import { isElectron, invoke } from "./desktop-bridge.js";
import { t, useLocale } from "./i18n.js";
import { screenError } from "./screen-errors.js";
import "./remote-screen.css";
type LocalScreenStatus = {
  /** With `supported: false`: `screen_platform_unsupported` when this computer
   * has no target implementation yet, `screen_native_unavailable` when the
   * native addon lacks the screen functions. */
  supported: boolean; reason?: string; registered?: boolean; phase?: "starting" | "connecting" | "registered" | "retrying" | "failed"; retryAt?: number; error?: string;
  permissions?: { capture: string; accessibility: boolean; inputMonitoring: boolean };
  desktop?: ScreenStatus["desktop"]; inputMonitoring?: boolean;
};
type PermissionResult = LocalScreenStatus & { requested: boolean; opened: boolean; requestError?: string };

/** Host status uses this GUI connection's device identity. Native status is
 * queried only after the selected Host has been proven to be this computer;
 * the native service, not the platform name, says whether it can be a target. */
export function RemoteScreenSettings({ connection, local, open, openBlocked, busyChange }: {
  connection: HubConnection; local: boolean; open?: () => void; openBlocked?: string; busyChange?: (busy: boolean) => void;
}) {
  useLocale();
  const state = useSyncExternalStore(notify => connection.subscribe(notify), () => connection.state);
  const desktopApp = isElectron();
  const localDesktop = local && desktopApp, localMac = localDesktop && window.openSuperAgentDesktop?.platform === "darwin";
  const [snapshot, setSnapshot] = useState<{ connection: HubConnection; status?: ScreenStatus; native?: LocalScreenStatus; error?: string; nativeError?: string }>();
  const [busy, setBusy] = useState(false), [actionError, setActionError] = useState("");
  const [permissionRequest, setPermissionRequest] = useState<{ kind: "capture" | "accessibility" | "input-monitoring"; opened: boolean }>();
  const readVersion = useRef(0);
  const lifetime = useRef<object | null>(null), operation = useRef(false), refresh = useRef<() => void>(() => {});
  const entryDescription = useId();
  const devicePermissions = useRef<HTMLDetailsElement>(null);
  const current = snapshot?.connection === connection ? snapshot : undefined;
  const status = current?.status, native = localDesktop ? current?.native : undefined;
  // This computer cannot be a target at all (e.g. Windows today). Reinstalling
  // does not help, and the switch and grants would suggest that it does.
  const targetUnsupported = native?.supported === false && native.reason === "screen_platform_unsupported";
  useEffect(() => {
    if (!desktopApp) return;
    const scope = {}; lifetime.current = scope;
    let reading = false, queued = false;
    setSnapshot(undefined); setActionError(""); setPermissionRequest(undefined); setBusy(false); operation.current = false;
    const read = async () => {
      if (lifetime.current !== scope) return;
      if (reading || operation.current) { queued = true; return; }
      queued = false; reading = true; const version = readVersion.current;
      const [host, desktop] = await Promise.allSettled([
        state.status === "online" && state.screenAvailable ? connection.screenStatus() : Promise.reject(new Error(state.status !== "online" ? "screen_host_offline" : "screen_host_update_required")),
        localDesktop ? invoke<LocalScreenStatus>("screen_service_status") : Promise.resolve(undefined),
      ]);
      if (lifetime.current === scope && !operation.current && readVersion.current === version) setSnapshot({ connection,
        status: host.status === "fulfilled" ? host.value : undefined,
        error: host.status === "rejected" ? reason(host.reason) : undefined,
        native: desktop.status === "fulfilled" ? desktop.value : undefined,
        nativeError: desktop.status === "rejected" ? reason(desktop.reason) : undefined,
      });
      reading = false;
      if (queued && !operation.current) void read();
    };
    refresh.current = () => { void read(); };
    void read();
    const timer = setInterval(() => { if (document.visibilityState === "visible") void read(); }, 3000);
    const focus = () => { if (document.visibilityState === "visible") void read(); };
    window.addEventListener("focus", focus); document.addEventListener("visibilitychange", focus);
    return () => { lifetime.current = null; clearInterval(timer); window.removeEventListener("focus", focus); document.removeEventListener("visibilitychange", focus); refresh.current = () => {}; busyChange?.(false); };
  }, [connection, desktopApp, localDesktop, state.status, state.screenAvailable, busyChange]);
  const run = async (work: () => Promise<unknown>) => {
    if (operation.current) return;
    const scope = lifetime.current;
    ++readVersion.current; operation.current = true; setBusy(true); busyChange?.(true); setActionError("");
    try { await work(); } catch (e) { if (lifetime.current === scope) setActionError(reason(e)); }
    finally { if (lifetime.current === scope) { operation.current = false; setBusy(false); busyChange?.(false); refresh.current(); } }
  };
  const save = (policy: ScreenPolicy) => run(() => connection.screenConfigure({ operation: "screen.configure", expectedRevision: policy.revision, enabled: policy.enabled, grants: policy.grants, requestId: crypto.randomUUID() }));
  const permission = (kind: "capture" | "accessibility" | "input-monitoring") => run(async () => {
    if (!localMac || !status?.canManage) return;
    const scope = lifetime.current;
    setPermissionRequest(undefined);
    const result = await invoke<PermissionResult>("screen_service_permission", { kind });
    if (lifetime.current === scope) {
      setPermissionRequest({ kind, opened: result.opened });
      if (result.requestError) setActionError(result.requestError);
    }
  });
  if (!desktopApp) return null;
  const permissions = native?.permissions ?? (native?.desktop ? { capture: native.desktop.capture, accessibility: native.desktop.accessibility, inputMonitoring: !!native.inputMonitoring } : undefined);
  const requestedPermissionGranted = permissionRequest?.kind === "capture" ? permissions?.capture === "granted"
    : permissionRequest?.kind === "accessibility" ? permissions?.accessibility : permissionRequest?.kind === "input-monitoring" ? permissions?.inputMonitoring : false;
  const blocked = targetUnsupported ? t("这台 Windows 电脑暂时不能被远程查看或控制，后续版本会支持。从这台电脑查看 Mac 不受影响。")
    : openBlocked || (state.status !== "online" ? t("主机暂时离线，请恢复连接后重试。")
    : !state.screenAvailable ? t("此主机需要更新后才能使用远程屏幕。")
    : !status ? current?.error ? t("无法读取屏幕状态，请刷新重试。") : t("正在读取屏幕状态，请稍候或刷新。")
    : !status.enabled ? t("请先在目标 Mac 开启允许远程屏幕。")
    : status.permission === "none" ? t("此设备尚未获得查看授权。")
    // A remote Host does not say which system it runs; only Macs register today.
    : !status.desktop ? local ? t("屏幕服务尚未注册，请在目标 Mac 检查或重试屏幕服务。") : t("屏幕服务尚未注册。请在目标电脑上打开 open-super-agent 并检查；目前只有 Mac 可以被远程查看。")
    : status.desktop.locked ? t("目标 Mac 已锁定，请在本机解锁后重新连接。")
    : status.desktop.capture !== "granted" ? t("请在目标 Mac 允许 open-super-agent 录制屏幕，再重新连接。")
    : !status.desktop.displays.length ? t("目标 Mac 没有可用显示器。") : !open ? t("此入口暂时无法打开屏幕，请重新打开连接设置。") : "");
  const error = actionError || current?.error || current?.nativeError;
  const nativePhase = native?.phase === "starting" ? t("正在启动") : native?.phase === "connecting" ? t("正在连接主机")
    : native?.phase === "registered" ? t("已注册") : native?.phase === "retrying" ? t("等待重试") : native?.phase === "failed" ? t("启动失败") : undefined;
  const serviceState = targetUnsupported ? t("暂不支持") : native && !native.supported ? t("不可用")
    : nativePhase && native?.phase !== "registered" ? nativePhase
    : !status ? current?.error ? t("未知") : t("正在读取…")
    : status.desktop ? t("已注册") : native?.registered ? t("等待主机确认")
    : status.canManage || status.permission !== "none" ? t("尚未注册") : t("授权后可查询");
  const devices = [...status?.devices ?? []].sort((a, b) => Number(b.id === connection.identity.deviceId) - Number(a.id === connection.identity.deviceId));
  const manageDevices = () => {
    const details = devicePermissions.current;
    if (!details) return;
    details.open = true;
    const target = details.querySelector<HTMLElement>('[data-current-device="true"] select') ?? details.querySelector("summary");
    target?.scrollIntoView({ block: "nearest" }); target?.focus({ preventScroll: true });
  };
  return <section className="screen-settings" aria-label={t("远程屏幕")}>
    <header className="screen-settings-heading">
      <h3>{t("远程屏幕")}</h3>
      {!targetUnsupported && status?.canManage && status.policy && <label className="screen-enable">
        <span>{t("允许远程屏幕")}</span>
        <input type="checkbox" checked={status.policy.enabled} disabled={busy} onChange={event => void save({ ...status.policy!, enabled: event.target.checked })}/>
      </label>}
    </header>
    {!targetUnsupported && status?.canManage && status.policy && <p className="screen-settings-intro">{t("开启后，仍需单独授权设备。")}</p>}
    <div className="screen-overview">
      <dl className="screen-readiness">
        <div><dt>{t("主机连接")}</dt><dd data-ready={state.status === "online"}>{state.status === "online" ? t("已连接") : t("未连接")}</dd></div>
        <div><dt>{t("屏幕服务")}</dt><dd data-ready={!!status?.desktop}>{serviceState}</dd></div>
        <div><dt>{t("此设备权限")}</dt><dd data-ready={!!status && status.permission !== "none"}>{!status ? current?.error ? t("未知") : t("正在读取…") : status.permission === "control" ? t("查看并控制") : status.permission === "view" ? t("仅查看") : t("未授权")}</dd></div>
      </dl>
      <div className="screen-entry-actions">
        <button className="screen-view-button" disabled={busy || !!blocked} aria-describedby={blocked ? entryDescription : undefined} onClick={() => { if (!busy && !blocked) open?.(); }}>{t("查看屏幕")}</button>
        <button className="screen-text-action" disabled={busy} onClick={() => refresh.current()}>{t("刷新状态")}</button>
      </div>
      {blocked && <div className="screen-entry-help"><p id={entryDescription}>{blocked}</p>
        {!targetUnsupported && status?.permission === "none" && (status.canManage && status.policy
          ? <button className="screen-text-action" disabled={busy} onClick={manageDevices}>{t("管理设备授权")}</button>
          : <p>{t("请在目标 Mac 的已配对设备列表中，明确允许此设备“仅查看”或“查看并控制”。")}</p>)}
      </div>}
    </div>
    {error && <p className="screen-notice" role="alert">{screenError(error)}</p>}
    {localDesktop && native && !targetUnsupported && <div className="screen-service-recovery">
      {native.phase === "retrying" && Number.isFinite(native.retryAt) && <p role="status">{t("自动重试时间：{0}", new Date(native.retryAt!).toLocaleTimeString())}</p>}
      {native.error && native.error !== error && <p className="screen-notice" role="status">{screenError(native.error)}</p>}
      {!native.supported && error !== "screen_native_unavailable" && native.error !== "screen_native_unavailable" && <p className="screen-notice" role="alert">{screenError("screen_native_unavailable")}</p>}
      {native.supported && !native.registered && <button disabled={busy || native.phase === "starting" || native.phase === "connecting" || native.error === "screen_service_updating"} onClick={() => void run(() => invoke("screen_service_retry", {}))}>{t("重试屏幕服务")}</button>}
    </div>}
    {!!status?.sessions.length && <div className="screen-active-sessions"><h4>{t("当前共享")}</h4>{status.sessions.map(session => <div className="screen-setting-row" key={session.id}><span>{session.deviceName}<small>{session.display.name} · {session.state === "controlling" ? t("正在控制") : t("查看中")}</small></span><button disabled={busy} onClick={() => void run(() => connection.screenStop(session.id))}>{t("断开")}</button></div>)}</div>}
    {!targetUnsupported && status?.canManage && status.policy && <>
      {localMac && <div className="screen-system-permissions">
        <h4>{t("本机系统权限")}</h4>
        <div className="screen-permissions">
          {([
            { kind: "capture", name: t("屏幕录制"), label: t("设置屏幕录制权限"), detail: t("查看屏幕所需"), granted: permissions?.capture === "granted" },
            { kind: "accessibility", name: t("辅助功能"), label: t("设置辅助功能权限"), detail: t("远程控制所需"), granted: permissions?.accessibility },
            { kind: "input-monitoring", name: t("输入监控"), label: t("设置输入监控权限"), detail: t("远程控制所需"), granted: permissions?.inputMonitoring },
          ] as const).map(item => <div className="screen-permission-row" role="group" aria-label={item.name} key={item.kind}>
            <div><span>{item.name}</span><small>{item.detail}</small></div>
            <span className="screen-permission-value" data-ready={!!permissions && item.granted}>{!permissions ? t("未检测") : item.granted ? t("已授权") : t("未授权")}</span>
            <button aria-label={item.label} disabled={busy} onClick={() => void permission(item.kind)}>{t("设置")}</button>
          </div>)}
        </div>
        {permissionRequest && <div className="screen-permission-help" role="status">
          <p>{permissionRequest.opened ? t("已打开系统设置，是否授权以返回后的检测结果为准。") : t("已检查权限，请以当前检测结果为准。")}</p>
          {!requestedPermissionGranted && <>
            <p>{t("列表中没有 open-super-agent 时，点击“+”，选择“应用程序”中当前安装的 open-super-agent；不要选择旧备份、Node 或其他应用。")}</p>
            <p>{t("若 macOS 要求重新打开应用，请先保存当前工作，再退出并重新打开 open-super-agent。打开设置页面不等于已授权。")}</p>
          </>}
        </div>}
      </div>}
      <details className="screen-device-permissions" ref={devicePermissions}>
        <summary>{t("设备授权")}</summary>
        <p>{t("配对和总开关不会自动授权设备。")}</p>
        {devices.map(device => <label className="screen-setting-row" data-current-device={device.id === connection.identity.deviceId} key={device.id}><span>{device.name}{device.id === connection.identity.deviceId && <small>{t("当前设备")}</small>}<small>{device.platform}</small></span><select aria-label={t("{0}的屏幕权限", device.name)} disabled={busy} value={status.policy!.grants.find(g => g.deviceId === device.id && g.publicKey === device.publicKey)?.permission ?? "none"} onChange={e => { const permission = e.target.value; void save({ ...status.policy!, grants: [...status.policy!.grants.filter(g => g.deviceId !== device.id), ...(permission === "none" ? [] : [{ deviceId: device.id, publicKey: device.publicKey, permission: permission as "view" | "control" }])] }); }}><option value="none">{t("不允许")}</option><option value="view">{t("仅查看")}</option><option value="control">{t("查看并控制")}</option></select></label>)}
      </details>
    </>}
    {!targetUnsupported && <details className="screen-permission-explanation"><summary>{t("权限说明")}</summary><p>{t("查看只需屏幕录制权限；远程控制还需辅助功能与输入监控。配对和总开关不会自动授权设备。")}</p></details>}

  </section>;
}
const reason = (error: unknown) => error instanceof Error ? error.message : String(error);
