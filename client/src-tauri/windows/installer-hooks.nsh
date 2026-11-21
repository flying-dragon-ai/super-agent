; Remember installation ownership BEFORE the upgrade page invokes the previous
; uninstaller. An interactive upgrade may not pass /UPDATE to that uninstaller.
; It must never be mistaken for a clean reinstall after its registry is removed.
Var OpenSuperAgentHadInstallation
Var OpenSuperAgentFreshPrepared
Var OpenSuperAgentClearSettings
!define MUI_CUSTOMFUNCTION_GUIINIT OpenSuperAgentRememberInstallation
Function OpenSuperAgentRememberInstallation
  ReadRegStr $OpenSuperAgentHadInstallation HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Open Super Agent" "UninstallString"
  ${If} $OpenSuperAgentHadInstallation == ""
    ReadRegStr $OpenSuperAgentHadInstallation HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Open Super Agent" "UninstallString"
  ${EndIf}
FunctionEnd

!macro OpenSuperAgentFreshStart HELPER
  Push $R0
  ClearErrors
  ExecWait '"${HELPER}" --prepare-fresh-install' $R0
  ${If} ${Errors}
    MessageBox MB_ICONSTOP|MB_OK "无法准备全新安装，原数据未被删除。请关闭 Open Super Agent 后重试。$\r$\nUnable to prepare a fresh start. Close Open Super Agent and retry." /SD IDOK
    Abort
  ${EndIf}
  ${If} $R0 == 21
    MessageBox MB_ICONSTOP|MB_OK "这台电脑安装了共享数据的 Open Super Agent CLI 服务，暂不能清空。请先运行 open-super-agent service uninstall，再重新安装。$\r$\nA CLI service owns this host. Uninstall that service before resetting." /SD IDOK
    Abort
  ${ElseIf} $R0 == 22
    MessageBox MB_ICONSTOP|MB_OK "本机主机仍在运行，或无法确认它已退出。请退出 Open Super Agent、停止本机 CLI 后重试。原数据会保留。$\r$\nHost shutdown could not be confirmed. Stop Open Super Agent and its CLI, then retry." /SD IDOK
    Abort
  ${ElseIf} $R0 == 24
    MessageBox MB_ICONSTOP|MB_OK "安装已停止：部分旧数据已备份，但恢复原位置失败。请保留 AppData 中的 Open Super Agent-backup 文件夹并联系支持，不要继续启动主机。$\r$\nReset rollback is incomplete. Preserve the Open Super Agent-backup folders and contact support." /SD IDOK
    Abort
  ${ElseIf} $R0 <> 0
    MessageBox MB_ICONSTOP|MB_OK "无法完成全新安装，数据未被删除。请关闭 Open Super Agent 后重试；若仍失败，请联系支持。$\r$\nFresh start could not finish. Data has not been deleted. Close Open Super Agent and retry." /SD IDOK
    Abort
  ${EndIf}
  Pop $R0
!macroend

!macro OpenSuperAgentStageRecovery
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File /oname=open-super-agent-recovery.exe "${MAINBINARYSRCPATH}"
  SetOutPath "$INSTDIR"
!macroend

; Tauri CLI 2.12.1 invokes POSTINSTALL after its owned Start Menu shortcuts.
; Reuse those links, including upgrade locations; never create another shortcut.
!macro OpenSuperAgentRegisterNotificationShortcut LINK
  !insertmacro IsShortcutTarget "${LINK}" "$INSTDIR\${MAINBINARYNAME}.exe"
  Pop $R0
  ${If} $R0 = 1
    ClearErrors
    ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --register-notification-shortcut "${LINK}"' $R0
    ${If} ${Errors}
    ${OrIf} $R0 <> 0
      DetailPrint "Open Super Agent notification shortcut registration failed."
      MessageBox MB_ICONSTOP|MB_OK "Open Super Agent 通知注册失败，请保留开始菜单快捷方式后重试安装。$\r$\nNotification registration failed. Retry installation with a Start Menu shortcut." /SD IDOK
      Abort
    ${EndIf}
    StrCpy $R1 1
  ${EndIf}
!macroend

!macro OpenSuperAgentStopLocalHost INSTALLER
  ; The companion had no runtime. Never signal unrelated node.exe processes.
  ${If} ${FileExists} "$INSTDIR\host\node.exe"
    ${AndIf} ${FileExists} "$INSTDIR\${MAINBINARYNAME}.exe"
    Push $R0
    ClearErrors
    ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --stop-desktop-host' $R0
    ${If} ${Errors}
    ${OrIf} $R0 <> 0
      !if "${INSTALLER}" == "1"
        ; The installed binary may predate native recovery and have a broken
        ; Node graph. Use the new helper only to VERIFY shutdown, never pretend
        ; to stop through a staged executable with no adjacent host runtime.
        !insertmacro OpenSuperAgentStageRecovery
        ClearErrors
        ExecWait '"$PLUGINSDIR\open-super-agent-recovery.exe" --confirm-host-stopped' $R0
        ${If} ${Errors}
          StrCpy $R0 1
        ${EndIf}
        Delete "$PLUGINSDIR\open-super-agent-recovery.exe"
      !endif
    ${EndIf}
    ${If} ${Errors}
    ${OrIf} $R0 <> 0
      MessageBox MB_ICONSTOP|MB_OK "无法停止本机主机，请退出 Open Super Agent 后重试。数据会保留。$\r$\nUnable to stop the local host. Please quit Open Super Agent and retry." /SD IDOK
      Abort
    ${EndIf}
    Pop $R0
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  StrCpy $OpenSuperAgentFreshPrepared 0
  ; Silent/passive installs and every upgrade keep state. Only an interactive
  ; reinstall with residual data offers a fresh start, and only after consent.
  ${IfNot} ${Silent}
  ${AndIf} $PassiveMode <> 1
  ${AndIf} $UpdateMode <> 1
  ${AndIf} $OpenSuperAgentHadInstallation == ""
    ${If} ${FileExists} "$APPDATA\com.opensuperagent.client"
    ${OrIf} ${FileExists} "$LOCALAPPDATA\com.opensuperagent.client"
    ${OrIf} ${FileExists} "$APPDATA\com.opensuperagent.client"
    ${OrIf} ${FileExists} "$LOCALAPPDATA\com.opensuperagent.client"
      MessageBox MB_ICONQUESTION|MB_YESNOCANCEL|MB_DEFBUTTON2 "发现上次安装留下的 Open Super Agent 数据。是否全新开始？$\r$\n$\r$\n是：备份这台电脑的旧配置、配对和本地数据，安装后像第一次使用一样重新配置。$\r$\n否：继续使用旧数据。$\r$\n取消：停止安装。$\r$\n$\r$\n不会修改 Mac mini 或其他主机。旧数据会保留在 AppData 的 Open Super Agent-backup 文件夹。$\r$\n$\r$\nPrevious data found. Start fresh?$\r$\nYes: back up local data and set up again. No: keep existing data." IDYES open_super_agent_fresh_install IDNO open_super_agent_keep_data
      Abort
      open_super_agent_fresh_install:
      !insertmacro CheckIfAppIsRunning "$INSTDIR\${MAINBINARYNAME}.exe" "${PRODUCTNAME}"
      !insertmacro OpenSuperAgentStageRecovery
      !insertmacro OpenSuperAgentFreshStart "$PLUGINSDIR\open-super-agent-recovery.exe"
      StrCpy $OpenSuperAgentFreshPrepared 1
      Delete "$PLUGINSDIR\open-super-agent-recovery.exe"
      open_super_agent_keep_data:
    ${EndIf}
  ${EndIf}
  ${If} $OpenSuperAgentFreshPrepared <> 1
    !insertmacro OpenSuperAgentStopLocalHost 1
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  Push $R0
  Push $R1
  StrCpy $R1 0
  !insertmacro OpenSuperAgentRegisterNotificationShortcut "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
  ${If} $R1 = 0
    !insertmacro OpenSuperAgentRegisterNotificationShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk"
  ${EndIf}
  ${If} $R1 = 0
    ; /NS or an upgrade with a deleted shortcut: do not report notification-ready.
    Delete "$INSTDIR\open-super-agent-notification-shortcut.json"
    DetailPrint "No owned Start Menu shortcut; Open Super Agent desktop notifications are unavailable."
  ${EndIf}
  Pop $R1
  Pop $R0
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Delete "$INSTDIR\open-super-agent-notification-shortcut.json"
  RMDir "$INSTDIR"
  ${If} $OpenSuperAgentClearSettings = 1
    DeleteRegKey SHCTX "${MANUPRODUCTKEY}"
    DeleteRegKey /ifempty SHCTX "${MANUKEY}"
    DeleteRegValue HKCU "${MANUPRODUCTKEY}" "Installer Language"
    DeleteRegKey /ifempty HKCU "${MANUPRODUCTKEY}"
    DeleteRegKey /ifempty HKCU "${MANUKEY}"
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro OpenSuperAgentStopLocalHost 0
  ${If} $UpdateMode <> 1
  ${AndIf} $DeleteAppDataCheckboxState = 1
    MessageBox MB_ICONQUESTION|MB_YESNO|MB_DEFBUTTON2 "移除这台电脑的 Open Super Agent 配置并保留恢复备份？$\r$\n$\r$\n旧配置和本地数据会移入 AppData 的 Open Super Agent-backup 文件夹，重装后从首次配置开始。这不是安全擦除。不会更改其他主机。$\r$\n$\r$\nRemove local configuration and keep a recovery backup? This is not secure erasure." IDYES open_super_agent_uninstall_fresh
    Abort
    open_super_agent_uninstall_fresh:
    !insertmacro CheckIfAppIsRunning "$INSTDIR\${MAINBINARYNAME}.exe" "${PRODUCTNAME}"
    !insertmacro OpenSuperAgentFreshStart "$INSTDIR\${MAINBINARYNAME}.exe"
    ; The native helper has backed up the fixed Known Folders. Never let the
    ; template recursively delete shared CLI data or an environment-derived path.
    StrCpy $DeleteAppDataCheckboxState 0
    StrCpy $OpenSuperAgentClearSettings 1
  ${EndIf}
  ; Updates retain history. An old install must not clear a newer owner's notices.
  ${If} $UpdateMode <> 1
    Push $R0
    ReadRegStr $R0 SHCTX "Software\Classes\opensuperagent\shell\open\command" ""
    ${If} $R0 == '$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\"'
      !insertmacro CheckIfAppIsRunning "$INSTDIR\${MAINBINARYNAME}.exe" "${PRODUCTNAME}"
      ClearErrors
      ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --clear-notification-history' $R0
      ${If} ${Errors}
      ${OrIf} $R0 <> 0
        MessageBox MB_ICONSTOP|MB_OK "无法清理 Open Super Agent 系统通知，请重试卸载。$\r$\nUnable to clear Open Super Agent notifications. Retry uninstalling." /SD IDOK
        Abort
      ${EndIf}
    ${EndIf}
    Pop $R0
  ${EndIf}
!macroend
