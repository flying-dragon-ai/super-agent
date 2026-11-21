; Electron installer hooks. Same semantics as client/src-tauri/windows/
; installer-hooks.nsh (fresh start only with consent, Host stopped before files
; change, notification shortcut ownership, history kept on update). Changes:
;   - recovery and fresh start use the standalone open-super-agent-installer-helper.exe:
;     an Electron executable cannot run from $PLUGINSDIR;
;   - Host shutdown asks the helper of an Electron install, or the main
;     executable of a Tauri install (`--stop-desktop-host`), whichever owns $INSTDIR.
; Notification registration/history stay with open-super-agent-client.exe, which must
; be the shortcut target.
!define OPEN_SUPER_AGENT_HELPERHELPER "open-super-agent-installer-helper.exe"
Var OpenSuperAgentHostStopper

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

!include "installer-diagnostics.nsh"

!macro BirdBackup HELPER PHASE PREFIX
  bird_backup_retry:
  StrCpy $BirdBackupState "$(birdNotStarted)"
  !insertmacro CheckIfAppIsRunning "$INSTDIR\${MAINBINARYNAME}.exe" "${DISPLAYNAME}"
  DetailPrint "$BirdOperation — ${PHASE}"
  ClearErrors
  SetDetailsPrint none
  ExecWait '"${HELPER}" --prepare-fresh-install-v2' $R0
  SetDetailsPrint lastused
  ${If} ${Errors}
    !insertmacro BirdProblem "${PHASE}" "$(birdLaunch)" "$(birdRepair)" "BACKUP-LAUNCH" bird_backup_retry
  ${EndIf}
  ${If} $R0 = 0
    StrCpy $BirdBackupState "$(birdCompleted)"
  ${ElseIf} $R0 = 10
    StrCpy $BirdBackupState "$(birdNoData)"
  ${ElseIf} $R0 = 60
    StrCpy $BirdBackupState "$(birdNotFinal)"
    !insertmacro BirdProblem "${PHASE}" "$(birdFinalKey)" "$(birdPreserve)" "B60" ""
  ${Else}
    StrCpy $BirdCode $R0
    ${If} $R0 >= 240
    ${AndIf} $R0 <= 258
      IntOp $BirdCode $R0 - 200
      StrCpy $BirdBackupState "$(birdPartial)"
    ${ElseIf} $R0 >= 140
    ${AndIf} $R0 <= 158
      IntOp $BirdCode $R0 - 100
      StrCpy $BirdBackupState "$(birdRolledBack)"
    ${Else}
      StrCpy $BirdBackupState "$(birdNotStarted)"
    ${EndIf}
    Call ${PREFIX}BirdDescribeReason
    ${If} $BirdNext == ""
      StrCpy $BirdBackupState "$(birdUnknownState)"
      !insertmacro BirdProblem "${PHASE}" "$(birdUnknown)" "$(birdPreserve)" "B-UNKNOWN" ""
    ${ElseIf} $R0 >= 240
      !insertmacro BirdProblem "${PHASE}" "$BirdReason" "$(birdPreserve)" "B$R0" ""
    ${Else}
      !insertmacro BirdProblem "${PHASE}" "$BirdReason" "$BirdNext" "B$R0" bird_backup_retry
    ${EndIf}
  ${EndIf}
  DetailPrint "$BirdOperation — $BirdBackupState"
!macroend

!macro OpenSuperAgentStageRecovery
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File /oname=open-super-agent-recovery.exe "${TB_HELPER}"
  SetOutPath "$INSTDIR"
!macroend

; Tauri CLI 2.12.1 invokes POSTINSTALL after its owned Start Menu shortcuts.
; Reuse those links, including upgrade locations; never create another shortcut.
!macro OpenSuperAgentRegisterNotificationShortcut LINK
  !define _TB_REG_ID ${__COUNTER__}
  !insertmacro IsShortcutTarget "${LINK}" "$INSTDIR\${MAINBINARYNAME}.exe"
  Pop $R0
  ${If} $R0 = 1
    bird_reg_notice_retry_${_TB_REG_ID}:
    DetailPrint "$BirdOperation — $(birdNoticeRegStage)"
    ClearErrors
    SetDetailsPrint none
    ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --register-notification-shortcut "${LINK}"' $R0
    SetDetailsPrint lastused
    ${If} ${Errors}
    ${OrIf} $R0 <> 0
      !insertmacro BirdProblem "$(birdNoticeRegStage)" "$(birdNoticeRegFailed)" "$(birdNoticeRegStep)" "NOTICE-REGISTER" bird_reg_notice_retry_${_TB_REG_ID}
    ${EndIf}
    StrCpy $R1 1
  ${EndIf}
  !undef _TB_REG_ID
!macroend

!macro OpenSuperAgentStopLocalHost INSTALLER
  !define _TB_STOP_ID ${__COUNTER__}
  bird_stop_retry_${_TB_STOP_ID}:
  ; Close this installation's running App via Restart Manager BEFORE stopping
  ; the local Host or moving data, so a background tray/app process cannot hold
  ; files open or respawn the Host. Never kill processes by name.
  !insertmacro CheckIfAppIsRunning "$INSTDIR\${MAINBINARYNAME}.exe" "${DISPLAYNAME}"
  ; Use only the stopper for this installation. Old Tauri installations use
  ; their main executable. Companion installations have no runtime.
  StrCpy $OpenSuperAgentHostStopper ""
  ${If} ${FileExists} "$INSTDIR\${OPEN_SUPER_AGENT_HELPERHELPER}"
    StrCpy $OpenSuperAgentHostStopper "$INSTDIR\${OPEN_SUPER_AGENT_HELPERHELPER}"
  ${ElseIf} ${FileExists} "$INSTDIR\host\node.exe"
    ${AndIf} ${FileExists} "$INSTDIR\${MAINBINARYNAME}.exe"
    StrCpy $OpenSuperAgentHostStopper "$INSTDIR\${MAINBINARYNAME}.exe"
  ${EndIf}
  ${If} $OpenSuperAgentHostStopper != ""
    DetailPrint "$BirdOperation — $(birdHostStage)"
    ClearErrors
    SetDetailsPrint none
    ExecWait '"$OpenSuperAgentHostStopper" --stop-desktop-host' $R0
    SetDetailsPrint lastused
    ${If} ${Errors}
      StrCpy $R0 1
    ${EndIf}
    !if "${INSTALLER}" == "1"
      ; Preserve the read-only fallback for old/broken stoppers, including
      ; a launch failure or timeout. Never override explicit ownership refusals.
      ${If} $R0 != 0
        ${If} $R0 < 40
        ${OrIf} $R0 > 58
        ${OrIf} $R0 = 55
        ${OrIf} $R0 = 56
          Push $R1
          StrCpy $R1 $R0
          !insertmacro OpenSuperAgentStageRecovery
          ClearErrors
          SetDetailsPrint none
          ExecWait '"$PLUGINSDIR\open-super-agent-recovery.exe" --confirm-host-stopped-v2' $R0
          SetDetailsPrint lastused
          ${If} ${Errors}
            StrCpy $R0 $R1
          ${EndIf}
          Delete "$PLUGINSDIR\open-super-agent-recovery.exe"
          Pop $R1
        ${EndIf}
      ${EndIf}
    !endif
    ${If} $R0 != 0
      StrCpy $BirdCode $R0
      !if "${INSTALLER}" == "1"
        Call BirdDescribeReason
      !else
        Call un.BirdDescribeReason
      !endif
      ${If} $BirdCode = 40
        StrCpy $BirdNext "$(birdCheckService)"
      ${EndIf}
      ${If} $BirdNext == ""
        !insertmacro BirdProblem "$(birdHostStage)" "$(birdStop)" "$(birdCloseHost)" "HOST-UNCONFIRMED" bird_stop_retry_${_TB_STOP_ID}
      ${Else}
        !insertmacro BirdProblem "$(birdHostStage)" "$BirdReason" "$BirdNext" "H$BirdCode" bird_stop_retry_${_TB_STOP_ID}
      ${EndIf}
    ${EndIf}
  ${EndIf}
  !undef _TB_STOP_ID
!macroend

!macro NSIS_HOOK_PREINSTALL
  StrCpy $BirdOperation "$(birdInstall)"
  StrCpy $BirdBackupState "$(birdNotRequested)"
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
      MessageBox MB_ICONQUESTION|MB_YESNOCANCEL|MB_DEFBUTTON2 "$(birdInstallConsent)" /SD IDCANCEL IDYES open_super_agent_fresh_install IDNO open_super_agent_keep_data
      Abort
      open_super_agent_fresh_install:
      StrCpy $BirdBackupState "$(birdNotStarted)"
      !insertmacro OpenSuperAgentStopLocalHost 1
      !insertmacro OpenSuperAgentStageRecovery
      !insertmacro BirdBackup "$PLUGINSDIR\open-super-agent-recovery.exe" "$(birdInstallBackup)" ""
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
  !insertmacro OpenSuperAgentRegisterNotificationShortcut "$SMPROGRAMS\$AppStartMenuFolder\${DISPLAYNAME}.lnk"
  ${If} $R1 = 0
    !insertmacro OpenSuperAgentRegisterNotificationShortcut "$SMPROGRAMS\${DISPLAYNAME}.lnk"
  ${EndIf}
  ${If} $R1 = 0
    !insertmacro OpenSuperAgentRegisterNotificationShortcut "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
  ${EndIf}
  ${If} $R1 = 0
    !insertmacro OpenSuperAgentRegisterNotificationShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk"
  ${EndIf}
  ${If} $R1 = 0
    ; /NS or an upgrade with a deleted shortcut: do not report notification-ready.
    Delete "$INSTDIR\open-super-agent-notification-shortcut.json"
    DetailPrint "No owned Start Menu shortcut; open-super-agent desktop notifications are unavailable."
  ${EndIf}
  ; Tauri -> Electron: an update skips the old uninstaller, so the Tauri Host
  ; runtime in host\ would stay forever. The helper takes no path: it removes
  ; exactly host\ beside itself, only an identified bundled runtime without
  ; reparse points, after resources\host is written and the Host is stopped.
  ; A refusal keeps the folder and never fails the installation.
  ${If} ${FileExists} "$INSTDIR\host\*.*"
    ClearErrors
    ExecWait '"$INSTDIR\${OPEN_SUPER_AGENT_HELPERHELPER}" --remove-legacy-host-runtime' $R0
    ${If} ${Errors}
    ${OrIf} $R0 <> 0
      DetailPrint "open-super-agent kept the previous host folder (code $R0)."
    ${EndIf}
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
  StrCpy $BirdOperation "$(birdUninstall)"
  StrCpy $BirdBackupState "$(birdNotRequested)"
  StrCpy $OpenSuperAgentClearSettings 0
  ${IfNot} ${Silent}
  ${AndIf} $PassiveMode <> 1
  ${AndIf} $UpdateMode <> 1
  ${AndIf} $DeleteAppDataCheckboxState = 1
    StrCpy $BirdBackupState "$(birdNotStarted)"
  ${EndIf}
  !insertmacro OpenSuperAgentStopLocalHost 0
  ${IfNot} ${Silent}
  ${AndIf} $PassiveMode <> 1
  ${AndIf} $UpdateMode <> 1
  ${AndIf} $DeleteAppDataCheckboxState = 1
    MessageBox MB_ICONQUESTION|MB_YESNO|MB_DEFBUTTON2 "$(birdUninstallConsent)" /SD IDNO IDYES open_super_agent_uninstall_fresh
    Abort
    open_super_agent_uninstall_fresh:
    !insertmacro BirdBackup "$INSTDIR\${OPEN_SUPER_AGENT_HELPERHELPER}" "$(birdUninstallBackup)" "un."
    ; Clear installer settings only after the backup returned a known success.
    StrCpy $DeleteAppDataCheckboxState 0
    StrCpy $OpenSuperAgentClearSettings 1
  ${EndIf}
  ; Updates retain history. An old install must not clear a newer owner's notices.
  ${If} $UpdateMode <> 1
    Push $R0
    bird_notice_retry:
    ReadRegStr $R0 SHCTX "Software\Classes\opensuperagent\shell\open\command" ""
    ${If} $R0 == '$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\"'
      !insertmacro CheckIfAppIsRunning "$INSTDIR\${MAINBINARYNAME}.exe" "${DISPLAYNAME}"
      DetailPrint "$BirdOperation — $(birdNoticeStage)"
      ClearErrors
      SetDetailsPrint none
      ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --clear-notification-history' $R0
      SetDetailsPrint lastused
      ${If} ${Errors}
      ${OrIf} $R0 <> 0
        !insertmacro BirdProblem "$(birdNoticeStage)" "$(birdNotice)" "$(birdNoticeStep)" "NOTICE-CLEAR" bird_notice_retry
      ${EndIf}
    ${EndIf}
    Pop $R0
  ${EndIf}
!macroend
