# Windows 通知：首条通知登记与「读不到 ≠ 已关闭」

2026-11-20。修复反馈：设置 → 通知显示「无法读取系统通知权限，请检查系统设置后重试。」，
且 Windows「通知」设置列表里找不到 Open Super Agent。本文记录代码改动与验收边界；
**没有在任何 Windows 真机上运行或验证**。

## 根因（推断，待真机确认）

未打包（非 MSIX）应用在发出第一条通知之前，`ToastNotifier.Setting` 可能读不到值，
返回 `0x80070490`（ERROR_NOT_FOUND）；Windows 也只在应用发过通知后才把它列进
通知设置。旧代码把读取失败当成错误，发送路径又先读 `Setting`，于是第一条通知
永远发不出去，形成死循环。外部依据见 Windows Community Toolkit 的
`ToastNotifierCompat.Setting`（读取前先发一条通知）。

## 行为

纯决策在 `client/src-tauri/src/notifications/windows_status.rs`
（`cfg(any(target_os = "windows", test))`，macOS 上可单测），WinRT 调用在
`windows.rs`。

| `Setting` 结果 | 只读 `permission(false)` | 发送 |
|---|---|---|
| `Enabled` | `granted` | 发送 |
| `Disabled*`（应用／总开关／策略／清单） | `denied` | 不发送，`native_notification_permission_denied` |
| `0x80070490` 未登记 | `prompt` | 照常 `Show` |
| `0x803E0105` 平台不可用 | 错误 `native_notification_platform_unavailable` | 照常 `Show`，如实返回结果 |
| 其他 HRESULT／未知枚举值 | `prompt` | 照常 `Show` |

- 只有系统**明确关闭**时才放弃发送；用户关闭时 Windows 自己会丢弃通知。
- 本进程已有一条通知被 `Show` 接受后，仍读不到的设置按 `granted` 报告，避免反复
  提示登记（`read_permission`）。
- `permission(true)` 只在用户打开「消息提醒」或点「重新启用通知」时调用：读不到时
  发一条**可见**的本地化确认通知（标题 Open Super Agent，正文由渲染进程传入，≤200 UTF-16），
  随后立即重读、最多再重试 3 次（间隔 150 ms）。`Enabled`→`granted`；`Disabled*`→`denied`；
  `Show` 成功但仍读不到→`granted`（诊断记 `registration: unverified`）；`Show` 失败按
  HRESULT 返回（`0x80070490`→`native_notification_identity_unresolved`，
  `0x803E0105`→`native_notification_platform_unavailable`，其余
  `native_notification_permission_failed`）。改为静默登记只需改 `Live::confirm`。
- 确认通知点击地址 `opensuperagent://notification/ready` 严格匹配，只聚焦窗口，不进 Inbox。

## 身份自愈（`windows_identity.rs`）

1. 每次检查，只读：先查回执里的快捷方式，再查安装器的已知位置
   （`Programs\open-super-agent.lnk`、`Programs\Open Super Agent\open-super-agent.lnk`、两处 `open-super-agent.lnk`）。
2. 仅 `permission(true)`：目标确为本 EXE、但缺 AUMID／CLSID 的快捷方式，用现有
   `register()` 补属性并重写回执；只读检查此时返回 `prompt`。
3. 仅用户点击「创建快捷方式并开启」（例如 `/NS` 安装）：主进程用
   `shell.writeShortcutLink` 在原生给出的 `Programs\open-super-agent.lnk` 创建（已存在则不覆盖），
   再由原生 `adopt_created_shortcut` 校验目标并写回执。卸载按目标匹配会删除它。
4. **未实现**：`HKCU\Software\Classes\AppUserModelId\com.opensuperagent.client` 注册表登记。
   接缝是 `register_app_user_model_id`，等真机对照实验决定。

## 诊断

`desktop_notification_diagnostics`（仅 Windows）返回有界 JSON：身份／回执／快捷方式
位置类别、设置分类、`Notifications\Settings\<AUMID>` 键是否存在（只读）、登记结果、
最近错误码、各步骤最近 HRESULT，主进程补 `os.release()`。不含路径、用户名、主机或
通知内容。设置页错误区显示「代码 0x… · 步骤」和「复制诊断信息」。

## 测试与交叉编译

- Rust：`cargo test --manifest-path client/src-desktop-native/Cargo.toml --no-default-features`
  覆盖分类表、登记状态机（假平台）、发送门控、身份分级、诊断与确认通知 XML。
- `cargo xwin check`／`clippy`：`client/src-desktop-native` 的 x86_64／aarch64
  `pc-windows-msvc`；`client/src-tauri/audit/windows-notifications` 同时纳入新模块。
  只证明能编译，不证明运行时行为。旧 Tauri 工程的完整检查需要先准备 host 运行时。
- Electron：`client/electron/tests/notifications.test.mjs`。
- Playwright（Chromium）：`notification-design` 新增 Windows 用例。
- `windows.yml` 新增不阻断的 `windows_toast_status_probe`；验收脚本 install 阶段新增
  只记录的 `notification-status-probe`（`info`，不计入结论）。Windows Server 运行器
  不能代替 Windows 10／11 真机。

## 真机验收（未做）

1. 在反馈机器的 Windows PowerShell 5.1 中读取本 AUMID 的 `Setting`，确认是否为 `0x80070490`。
2. 全新安装后打开「消息提醒」：出现确认通知，开关保持开启，Open Super Agent 出现在系统通知列表。
3. 从 1.5.1 升级后不重装即可开启。
4. 系统里关闭 Open Super Agent／总开关／策略禁用时的状态与文案；重新打开后恢复。
5. 真实消息通知显示与冷／热启动点击；确认通知点击只聚焦窗口。
6. `/NS` 安装：「创建快捷方式并开启」可用；卸载后快捷方式与回执清理干净。
7. Windows 10 22H2 与 Windows 11 各一遍，核对中英文设置路径名称（「通知」／
   「通知和操作」）。
8. 对照实验：仅快捷方式、仅注册表、两者都有，决定是否实现第 4 级。
