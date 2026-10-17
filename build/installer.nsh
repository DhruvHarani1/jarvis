; Extra NSIS steps for Jarvis (included via nsis.include).
!macro customInit
  ; Reinstall/update into the folder it is already installed in, never a second copy.
  ReadRegStr $R2 HKCU "${INSTALL_REGISTRY_KEY}" "InstallLocation"
  ${If} $R2 != ""
    ${If} ${FileExists} "$R2\${APP_EXECUTABLE_FILENAME}"
      StrCpy $INSTDIR "$R2"
    ${EndIf}
  ${EndIf}
!macroend

!macro customUnInstall
  ; Downloaded updates live next to the install folder (not inside it). Remove them on a real uninstall,
  ; but not during an update, when the running installer is in there.
  ${ifNot} ${isUpdated}
    RMDir /r "$INSTDIR-updates"
  ${endIf}
  ; Remove the "launch at startup" entry so uninstalling leaves nothing running at login.
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Jarvis"
!macroend
