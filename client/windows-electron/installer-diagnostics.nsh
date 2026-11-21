; Only localized constants and allowlisted reason codes enter these dialogs.
; The standard Windows MessageBox copies its caption and text with Ctrl+C.
Var BirdOperation
Var BirdBackupState
Var BirdCode
Var BirdReason
Var BirdNext
Var BirdMessage

!macro BirdProblem PHASE REASON ACTION CODE RETRY
  StrCpy $BirdMessage "$BirdOperation — ${PHASE}$\r$\n${REASON}$\r$\n$BirdBackupState$\r$\n$\r$\n${ACTION}$\r$\n$\r$\nopen-super-agent ${VERSION} · TB-${CODE} · $(birdCopy)"
  DetailPrint "$BirdMessage"
  ${IfNot} ${Silent}
  ${AndIf} $PassiveMode != 1
    !if "${RETRY}" == ""
      MessageBox MB_ICONSTOP|MB_OK "$BirdMessage" /SD IDOK
    !else
      MessageBox MB_ICONEXCLAMATION|MB_RETRYCANCEL|MB_DEFBUTTON2 "$BirdMessage" /SD IDCANCEL IDRETRY ${RETRY}
    !endif
  ${EndIf}
  Abort "$BirdOperation — ${PHASE} (TB-${CODE})"
!macroend

; Installer and uninstaller are separate NSIS programs. Both decode the same
; finite Rust Reason values. Unknown values never authorize a backup retry.
!macro BirdReasonFunction PREFIX
Function ${PREFIX}BirdDescribeReason
  ${Select} $BirdCode
    ${Case} 40
      StrCpy $BirdReason "$(birdService)"
      StrCpy $BirdNext "$(birdServiceStep)"
    ${Case} 41
      StrCpy $BirdReason "$(birdRunning)"
      StrCpy $BirdNext "$(birdCloseHost)"
    ${Case} 42
      StrCpy $BirdReason "$(birdOwner)"
      StrCpy $BirdNext "$(birdOwnerStep)"
    ${Case} 43
      StrCpy $BirdReason "$(birdProcess)"
      StrCpy $BirdNext "$(birdCloseHost)"
    ${Case} 44
      StrCpy $BirdReason "$(birdDenied)"
      StrCpy $BirdNext "$(birdPermissions)"
    ${Case} 45
      StrCpy $BirdReason "$(birdUnreadable)"
      StrCpy $BirdNext "$(birdPermissions)"
    ${Case} 46
      StrCpy $BirdReason "$(birdRedirect)"
      StrCpy $BirdNext "$(birdLayoutStep)"
    ${Case} 47
      StrCpy $BirdReason "$(birdUnavailable)"
      StrCpy $BirdNext "$(birdPermissions)"
    ${Case} 48
      StrCpy $BirdReason "$(birdInvalid)"
      StrCpy $BirdNext "$(birdRepair)"
    ${Case} 49
      StrCpy $BirdReason "$(birdExists)"
      StrCpy $BirdNext "$(birdKeepBackup)"
    ${Case} 50
      StrCpy $BirdReason "$(birdCreate)"
      StrCpy $BirdNext "$(birdCreateStep)"
    ${Case} 51
      StrCpy $BirdReason "$(birdCreateDenied)"
      StrCpy $BirdNext "$(birdCreateStep)"
    ${Case} 52
      StrCpy $BirdReason "$(birdMove)"
      StrCpy $BirdNext "$(birdMoveStep)"
    ${Case} 53
      StrCpy $BirdReason "$(birdMoveDenied)"
      StrCpy $BirdNext "$(birdMoveStep)"
    ${Case} 54
      StrCpy $BirdReason "$(birdConflict)"
      StrCpy $BirdNext "$(birdOwnerStep)"
    ${Case} 55
      StrCpy $BirdReason "$(birdStop)"
      StrCpy $BirdNext "$(birdCloseHost)"
    ${Case} 56
      StrCpy $BirdReason "$(birdTimeout)"
      StrCpy $BirdNext "$(birdCloseHost)"
    ${Case} 57
      StrCpy $BirdReason "$(birdUpdate)"
      StrCpy $BirdNext "$(birdWaitUpdate)"
    ${Case} 58
      StrCpy $BirdReason "$(birdStorage)"
      StrCpy $BirdNext "$(birdLayoutStep)"
    ${CaseElse}
      StrCpy $BirdReason "$(birdUnknown)"
      StrCpy $BirdNext ""
  ${EndSelect}
FunctionEnd
!macroend
!insertmacro BirdReasonFunction ""
!insertmacro BirdReasonFunction "un."
