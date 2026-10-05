param(
  [Parameter(Mandatory = $true)][string]$PidValues,
  [Parameter(Mandatory = $true)][int]$ParentPidValue,
  [Parameter(Mandatory = $true)][long]$DeadlineEpochMs,
  [Parameter(Mandatory = $true)][int]$DurationCapMs
)

$ErrorActionPreference = 'Stop'
$elapsed = [System.Diagnostics.Stopwatch]::StartNew()
$startGate = [System.Threading.ManualResetEventSlim]::new($false)
$ownerScript = {
  param($gate)
  $stream = [Console]::OpenStandardInput()
  $first = $stream.ReadByte()
  if ($first -lt 0) { return }
  $gate.Set()
  while ($stream.ReadByte() -ge 0) {}
}
$queryScript = {
  param($pidValues, $parentPidValue, $gate)
  $gate.Wait()

  function Convert-ThreadState($state) {
    switch ([string]$state) {
      'Initialized' { return 'initialized' }
      'Ready' { return 'ready' }
      'Running' { return 'running' }
      'Standby' { return 'standby' }
      'Terminated' { return 'terminated' }
      'Wait' { return 'wait' }
      'Transition' { return 'transition' }
      default { return 'unknown' }
    }
  }

  function Convert-WaitReason($reason) {
    switch ([string]$reason) {
      'Executive' { return 'executive' }
      'FreePage' { return 'free-page' }
      'PageIn' { return 'page-in' }
      'SystemAllocation' { return 'pool-allocation' }
      'ExecutionDelay' { return 'execution-delay' }
      'Suspended' { return 'suspended' }
      'UserRequest' { return 'user-request' }
      'EventPairHigh' { return 'event-pair-high' }
      'EventPairLow' { return 'event-pair-low' }
      'LpcReceive' { return 'lpc-receive' }
      'LpcReply' { return 'lpc-reply' }
      'VirtualMemory' { return 'virtual-memory' }
      'PageOut' { return 'page-out' }
      default { return 'unknown' }
    }
  }

  function Read-ProcessSample([int]$targetPid, $knownParentPid) {
    try {
      $process = [System.Diagnostics.Process]::GetProcessById($targetPid)
    } catch [System.ArgumentException] {
      return @{ status = 'unavailable'; reason = 'process-absent' }
    } catch {
      return @{ status = 'unavailable'; reason = 'access-unavailable' }
    }
    try {
      $createdAtMs = [long]([DateTimeOffset]$process.StartTime).ToUnixTimeMilliseconds()
      $first = @{
        userMs = [double]$process.UserProcessorTime.TotalMilliseconds
        kernelMs = [double]$process.PrivilegedProcessorTime.TotalMilliseconds
        threadCount = [int]$process.Threads.Count
      }
      $threads = @()
      $count = 0
      foreach ($thread in $process.Threads) {
        if ($count -ge 16) { break }
        $state = Convert-ThreadState $thread.ThreadState
        $waitReason = if ($state -eq 'wait') { Convert-WaitReason $thread.WaitReason } else { 'not-applicable' }
        $threads += @{
          id = [int]$thread.Id
          state = $state
          waitReason = $waitReason
        }
        $count += 1
      }
      $process.Refresh()
      $secondCreatedAtMs = [long]([DateTimeOffset]$process.StartTime).ToUnixTimeMilliseconds()
      if ($createdAtMs -ne $secondCreatedAtMs) {
        return @{ status = 'unavailable'; reason = 'identity-changed' }
      }
      $second = @{
        userMs = [double]$process.UserProcessorTime.TotalMilliseconds
        kernelMs = [double]$process.PrivilegedProcessorTime.TotalMilliseconds
        threadCount = [int]$process.Threads.Count
      }
      return @{
        status = 'captured'
        pid = [int]$process.Id
        parentPid = $knownParentPid
        createdAtMs = $createdAtMs
        secondCreatedAtMs = $secondCreatedAtMs
        first = $first
        second = $second
        threads = @($threads)
        omittedThreads = [Math]::Max(0, $first.threadCount - $count)
      }
    } catch [System.ArgumentException], [System.InvalidOperationException] {
      return @{ status = 'unavailable'; reason = 'process-absent' }
    } catch {
      return @{ status = 'unavailable'; reason = 'access-unavailable' }
    } finally {
      $process.Dispose()
    }
  }

  $shells = @()
  foreach ($targetPid in $pidValues) {
    $shells += (Read-ProcessSample $targetPid $null)
  }
  [Console]::Out.WriteLine('SHELL ' + (ConvertTo-Json -InputObject @{ version = 1; shells = @($shells) } -Depth 12 -Compress))
  [Console]::Out.Flush()
  $pidValue = $pidValues[0]
  try {
    $identity = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=$pidValue" -Property ProcessId, ParentProcessId -ErrorAction Stop
    if ($null -ne $identity -and $shells[0].status -eq 'captured') { $shells[0].parentPid = [int]$identity.ParentProcessId }
  } catch {}
  $console = @{ status = 'unavailable'; reason = 'console-identity-unavailable' }
  if ($parentPidValue -gt 0) {
    try {
      $rows = @(Get-CimInstance -ClassName Win32_Process -Filter "(Name='conhost.exe' OR Name='OpenConsole.exe') AND ParentProcessId=$parentPidValue" -Property ProcessId, ParentProcessId -ErrorAction Stop)
      $candidates = @()
      $unavailableCandidates = @()
      foreach ($row in ($rows | Select-Object -First 4)) {
        $sample = Read-ProcessSample ([int]$row.ProcessId) ([int]$row.ParentProcessId)
        if ($sample.status -eq 'captured') {
          $candidates += $sample
        } else {
          $unavailableCandidates += @{ reason = $sample.reason; count = 1 }
        }
      }
      $console = @{
        status = 'captured'
        candidateCount = [int]$rows.Count
        candidates = @($candidates)
        unavailableCandidates = @($unavailableCandidates)
        omittedCandidates = [Math]::Max(0, $rows.Count - 4)
      }
    } catch {
      $console = @{ status = 'unavailable'; reason = 'access-unavailable' }
    }
  }
  return @{ version = 1; shells = @($shells); console = $console }
}

try {
  $pids = @($PidValues.Split(',') | ForEach-Object { [int]::Parse($_) })
  if ($pids.Count -lt 1 -or $pids.Count -gt 8 -or @($pids | Where-Object { $_ -le 0 }).Count -gt 0) {
    [Environment]::Exit(88)
  }
  $ownerRunspace = [System.Management.Automation.Runspaces.RunspaceFactory]::CreateRunspace()
  $queryRunspace = [System.Management.Automation.Runspaces.RunspaceFactory]::CreateRunspace()
  $ownerRunspace.Open()
  $queryRunspace.Open()
  $owner = [System.Management.Automation.PowerShell]::Create()
  $query = [System.Management.Automation.PowerShell]::Create()
  $owner.Runspace = $ownerRunspace
  $query.Runspace = $queryRunspace
  [void]$owner.AddScript($ownerScript.ToString()).AddArgument($startGate)
  [void]$query.AddScript($queryScript.ToString()).AddArgument($pids).AddArgument($ParentPidValue).AddArgument($startGate)
  $ownerTask = $owner.BeginInvoke()
  $queryTask = $query.BeginInvoke()
  [Console]::Out.WriteLine('READY')
  [Console]::Out.Flush()
  $handles = [System.Threading.WaitHandle[]]@($ownerTask.AsyncWaitHandle, $queryTask.AsyncWaitHandle)
  while ($true) {
    $remaining = [Math]::Min(
      $DeadlineEpochMs - [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(),
      $DurationCapMs - $elapsed.ElapsedMilliseconds
    )
    if ($remaining -le 0) { [Environment]::Exit(87) }
    $winner = [System.Threading.WaitHandle]::WaitAny($handles, [int][Math]::Min($remaining, 2147483647))
    if ($winner -eq 0) { [Environment]::Exit(86) }
    if ($winner -eq 1) {
      $records = $query.EndInvoke($queryTask)
      if ($records.Count -ne 1) { [Environment]::Exit(88) }
      $json = ConvertTo-Json -InputObject $records[0].psobject.BaseObject -Depth 12 -Compress
      [Console]::Out.WriteLine('RESULT ' + $json)
      [Console]::Out.Flush()
      [Environment]::Exit(0)
    }
    [Environment]::Exit(87)
  }
} catch {
  [Environment]::Exit(88)
}
