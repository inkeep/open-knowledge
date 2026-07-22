; OpenKnowledge NSIS customizations (wired via nsis.include in
; electron-builder.yml). Two jobs, both per-user / elevation-free (D1
; one-click per-user install):
;
;   1. CLI-on-PATH (D10): append "$INSTDIR\resources\cli\bin" (ok.cmd /
;      ok.ps1 wrappers) to the USER Path value (HKCU\Environment) at
;      install, remove it at uninstall. Idempotent — silent update
;      re-installs run customInstall again and must not accumulate
;      duplicates. WM_SETTINGCHANGE broadcast so new shells pick it up
;      without relogin (cmd.exe sessions already open won't).
;
;   2. openknowledge:// protocol (D2/Q8): HKCU\Software\Classes keys.
;      electron-builder's `protocols` config is macOS-Info.plist-only, so
;      NSIS writes the registry shape here; the app also self-heals it at
;      startup via app.setAsDefaultProtocolClient (reclaim posture), so
;      these keys mainly cover the installed-but-never-launched window.
;
; PATH surgery notes: comparisons are done against "<Path>;" with a
; "<dir>;" needle so the final un-terminated entry still matches. The
; StrFunc.nsh ${StrStr}/${UnStrStr} pair ships with NSIS 3 (bundled by
; electron-builder). Case-sensitive match is acceptable — the only writer
; of this exact dir string is this installer, so the dedup check only has
; to recognize its own prior writes.

!include "StrFunc.nsh"
; StrFunc.nsh requires one-time declaration before use in each context —
; but electron-builder compiles this script twice (a BUILD_UNINSTALLER
; pass that emits only the uninstaller, then the installer pass), and a
; StrFunc helper declared in a pass that never references it trips
; makensis "warning 6010: function not referenced", which electron-builder
; promotes to an error. Declare each helper only in the pass that uses it.
!ifdef BUILD_UNINSTALLER
  ${UnStrStr}
!else
  ${StrStr}
!endif

!define OK_CLI_BIN_SUFFIX "resources\cli\bin"

!macro customInstall
  ; ---- user PATH append (idempotent) ----
  ReadRegStr $0 HKCU "Environment" "Path"
  ; Normalize a pre-existing trailing ";" so the append below never writes
  ; a double ";" (an empty PATH segment). Empty $0 falls through untouched.
  StrCpy $3 $0 1 -1
  StrCmp $3 ";" 0 +2
    StrCpy $0 $0 -1
  StrCpy $1 "$INSTDIR\${OK_CLI_BIN_SUFFIX}"
  ${StrStr} $2 "$0;" "$1;"
  StrCmp $2 "" 0 +5
    StrCmp $0 "" 0 +3
      WriteRegExpandStr HKCU "Environment" "Path" "$1"
      Goto +2
    WriteRegExpandStr HKCU "Environment" "Path" "$0;$1"
  SendMessage ${HWND_BROADCAST} ${WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=5000

  ; ---- openknowledge:// protocol (per-user, no elevation) ----
  WriteRegStr HKCU "Software\Classes\openknowledge" "" "URL:OpenKnowledge"
  WriteRegStr HKCU "Software\Classes\openknowledge" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\openknowledge\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\openknowledge\shell" "" "open"
  WriteRegStr HKCU "Software\Classes\openknowledge\shell\open" "" "Open with ${PRODUCT_NAME}"
  WriteRegStr HKCU "Software\Classes\openknowledge\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
!macroend

!macro customUnInstall
  ; ---- user PATH removal ----
  ; Remove "<dir>;" from "<Path>;" then strip the trailing ";" we added
  ; for the match. Handles first / middle / last / only-entry positions
  ; in one shape. If the entry is absent (user hand-edited), leave Path
  ; untouched.
  ReadRegStr $0 HKCU "Environment" "Path"
  StrCpy $1 "$INSTDIR\${OK_CLI_BIN_SUFFIX}"
  ${UnStrStr} $2 "$0;" "$1;"
  StrCmp $2 "" un_path_done
    ; $2 = substring starting at our entry (within "$0;"). Compute prefix
    ; length = len("$0;") - len($2), then rebuild prefix + suffix-after-entry.
    StrLen $3 "$0;"
    StrLen $4 $2
    IntOp $5 $3 - $4          ; chars before our entry
    StrCpy $6 "$0;" $5        ; prefix (everything before "<dir>;")
    StrLen $7 "$1;"
    StrCpy $8 $2 "" $7        ; suffix (everything after "<dir>;")
    StrCpy $9 "$6$8"          ; recombined, still ";"-terminated unless empty
    ; strip one trailing ";" if present
    StrCpy $3 $9 1 -1
    StrCmp $3 ";" 0 +2
      StrCpy $9 $9 -1
    WriteRegExpandStr HKCU "Environment" "Path" $9
    SendMessage ${HWND_BROADCAST} ${WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=5000
un_path_done:

  ; ---- openknowledge:// protocol keys ----
  ; Only drop the class if it still points at this install — a later
  ; reinstall elsewhere (or another channel) may own it now.
  ReadRegStr $0 HKCU "Software\Classes\openknowledge\shell\open\command" ""
  ${UnStrStr} $1 "$0" "$INSTDIR"
  StrCmp $1 "" +2
    DeleteRegKey HKCU "Software\Classes\openknowledge"
!macroend
