# Wrapper script shipped inside the OpenKnowledge Windows install
# (<INSTDIR>\resources\cli\bin\ok.ps1). PowerShell sibling of ok.cmd for
# hosts that resolve .ps1 ahead of .cmd (or where cmd.exe is unavailable).
# Re-uses the bundled Electron runtime as a Node host via
# ELECTRON_RUN_AS_NODE=1 - no separate Node install required.

$installDir = Resolve-Path (Join-Path $PSScriptRoot '..\..\..')
$electron = Join-Path $installDir 'OpenKnowledge.exe'
$cli = Join-Path $PSScriptRoot '..\dist\cli.mjs'

if (-not (Test-Path $electron) -or -not (Test-Path $cli)) {
  # Mirrors ok.sh / ok.cmd's ok-bundle-missing contract: two-line stderr
  # (human-readable + machine-readable JSON), exit 69 (EX_UNAVAILABLE).
  [Console]::Error.WriteLine('OpenKnowledge has been removed. Reinstall from the OpenKnowledge installer.')
  [Console]::Error.WriteLine('{"error":"ok-bundle-missing","hint":"OpenKnowledge app appears to have been removed. Reinstall it, or remove OK entries from your MCP config and rerun ok init."}')
  exit 69
}

# Sanitize NODE_OPTIONS (VS Code pattern; mirrors ok.sh) - re-export under a
# scoped name so the CLI can opt to honor them explicitly.
$env:OK_NODE_OPTIONS = $env:NODE_OPTIONS
Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue

$env:ELECTRON_RUN_AS_NODE = '1'
& $electron $cli @args
exit $LASTEXITCODE
