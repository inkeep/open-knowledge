@echo off
setlocal

rem Wrapper script shipped inside the OpenKnowledge Windows install
rem (<INSTDIR>\resources\cli\bin\ok.cmd). Re-uses the bundled Electron
rem runtime as a Node host via ELECTRON_RUN_AS_NODE=1 - no separate Node
rem install required on the user machine. Derived from VS Code's bin\code.cmd.
rem The NSIS include (build/installer.nsh) appends this script's directory to
rem the user PATH at install time and removes it at uninstall.
rem
rem Layout (per-user NSIS install, %LOCALAPPDATA%\Programs\OpenKnowledge):
rem   %~dp0            = <INSTDIR>\resources\cli\bin\
rem   %~dp0..\dist     = <INSTDIR>\resources\cli\dist   (bundled CLI)
rem   %~dp0..\..\..    = <INSTDIR>                      (OpenKnowledge.exe)

rem Sanitize NODE_OPTIONS the user may have set for their own projects -
rem they would otherwise be inherited into the Electron-as-Node process and
rem can crash with "--require of ESM". Re-export under a scoped name so the
rem CLI can opt to honor them explicitly (VS Code pattern; mirrors ok.sh).
set "OK_NODE_OPTIONS=%NODE_OPTIONS%"
set "NODE_OPTIONS="

set "ELECTRON_RUN_AS_NODE=1"

if not exist "%~dp0..\..\..\OpenKnowledge.exe" goto :missing
if not exist "%~dp0..\dist\cli.mjs" goto :missing

"%~dp0..\..\..\OpenKnowledge.exe" "%~dp0..\dist\cli.mjs" %*
endlocal & exit /b %ERRORLEVEL%

:missing
rem Self-diagnose the uninstalled/moved lifecycle: MCP clients may hold this
rem wrapper path in their configs after the app is removed. Two-line stderr
rem (human-readable + machine-readable JSON) and exit 69 (EX_UNAVAILABLE),
rem mirroring ok.sh's ok-bundle-missing contract.
echo OpenKnowledge has been removed. Reinstall from the OpenKnowledge installer. 1>&2
echo {"error":"ok-bundle-missing","hint":"OpenKnowledge app appears to have been removed. Reinstall it, or remove OK entries from your MCP config and rerun ok init."} 1>&2
endlocal & exit /b 69
