$ErrorActionPreference = 'Stop'
$readerRoot = $PSScriptRoot
$dataPath = Join-Path $readerRoot 'data'
New-Item -ItemType Directory -Path $dataPath -Force | Out-Null
$runtimePath = Join-Path $dataPath 'runtime.json'
$runtime = $null
if (Test-Path -LiteralPath $runtimePath) {
    try {
        $candidate = Get-Content -LiteralPath $runtimePath -Raw | ConvertFrom-Json
        if ($candidate.url -match '^http://127\.0\.0\.1:\d+$') {
            $health = Invoke-RestMethod -Uri ($candidate.url + '/health') -TimeoutSec 2
            if ($health.app -eq 'codex-reader' -and $health.version -eq '0.11.1' -and $health.pid -eq $candidate.pid) { $runtime = $candidate }
            elseif ($health.app -eq 'codex-reader' -and $health.pid -eq $candidate.pid -and $candidate.token -match '^[a-f0-9]{64}$') {
                # Gracefully release the previous reader's conversation writers before upgrading.
                Invoke-RestMethod -Uri ($candidate.url + '/api/shutdown') -Method Post -Headers @{ Cookie = ('reader=' + $candidate.token); Origin = $candidate.url } -ContentType 'application/json' -Body '{}' -TimeoutSec 5 | Out-Null
                for ($releaseAttempt = 0; $releaseAttempt -lt 60; $releaseAttempt++) {
                    Start-Sleep -Milliseconds 200
                    try { $null = Invoke-RestMethod -Uri ($candidate.url + '/health') -TimeoutSec 1 } catch { break }
                }
            }
        }
    } catch { }
}
if (-not $runtime) {
    $nodePath = $env:CODEX_READER_NODE
    if (-not $nodePath) { $nodeCmd = Get-Command node.exe -ErrorAction SilentlyContinue; if ($nodeCmd) { $nodePath = $nodeCmd.Source } }
    if (-not $nodePath) {
        $bundledNode = Join-Path $readerRoot 'runtime/node.exe'
        $codexNode = Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
        if (Test-Path -LiteralPath $bundledNode) { $nodePath = $bundledNode }
        elseif (Test-Path -LiteralPath $codexNode) { $nodePath = $codexNode }
    }
    if (-not $nodePath -or -not (Test-Path -LiteralPath $nodePath)) { throw 'Node.js 22+ was not found. Install Node.js or set CODEX_READER_NODE to node.exe.' }
    $serverScript = Join-Path $readerRoot 'server.mjs'
    $readerRunTag = [guid]::NewGuid().ToString('N').Substring(0,8)
    $readerErrorLog = Join-Path $dataPath ('error-' + $readerRunTag + '.log')
    Start-Process -FilePath $nodePath -ArgumentList @('"' + $serverScript + '"') -WorkingDirectory $readerRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $dataPath ('server-' + $readerRunTag + '.log')) -RedirectStandardError $readerErrorLog | Out-Null
    for ($attempt = 0; $attempt -lt 80; $attempt++) {
        Start-Sleep -Milliseconds 150
        if (Test-Path -LiteralPath $runtimePath) {
            try {
                $candidate = Get-Content -LiteralPath $runtimePath -Raw | ConvertFrom-Json
                if ($candidate.url -notmatch '^http://127\.0\.0\.1:\d+$') { continue }
                $health = Invoke-RestMethod -Uri ($candidate.url + '/health') -TimeoutSec 1
                if ($health.app -eq 'codex-reader' -and $health.version -eq '0.11.1' -and $health.pid -eq $candidate.pid) { $runtime = $candidate; break }
            } catch { }
        }
    }
    if (-not $runtime) { throw ('Reader did not start. See ' + $readerErrorLog) }
}
$launchUrl = $runtime.url + '/#' + $runtime.token
$edgeCandidates = @(
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe"
)
$edgePath = $edgeCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if ($edgePath) {
    Start-Process -FilePath $edgePath -ArgumentList @('--app=' + $launchUrl, '--window-size=1360,900')
} else { Start-Process $launchUrl }
