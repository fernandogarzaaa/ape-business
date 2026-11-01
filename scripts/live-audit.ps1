# Live APE exercise battery â€” drives the MCP (HTTP) + console exactly like a
# plugin client would. Usage: powershell -File scripts/live-audit.ps1
# NOTE: never name a param `$args` (PowerShell automatic variable) â€” payloads go empty.
$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot
$mcpPort = 18771
$api = "http://127.0.0.1:$mcpPort"
$results = @()

function Check($name, $cond, $detail = "") {
  $script:results += @{ name = $name; pass = [bool]$cond; detail = $detail }
  Write-Output ("[{0}] {1} {2}" -f ($(if ($cond) { "PASS" } else { "FAIL" }), $name, $detail))
}

function WaitReady($url, $tries = 20) {
  for ($i = 0; $i -lt $tries; $i++) {
    try { $null = Invoke-RestMethod -Uri $url -TimeoutSec 2; return $true } catch { Start-Sleep -Milliseconds 500 }
  }
  return $false
}

function McpCall($tool, $params) {
  $body = @{ name = $tool; arguments = $params } | ConvertTo-Json -Depth 6 -Compress
  return Invoke-RestMethod -Uri "$api/call" -Method Post -Body $body -ContentType "application/json" -Headers @{ "Mcp-Method" = "tools/call" }
}

$jm = Start-Job -ArgumentList $root, $mcpPort -ScriptBlock {
  param($repoRoot, $port)
  Set-Location $repoRoot
  node bin/ape-mcp.js --http $port
}
Check "server-ready" (WaitReady "$api/discover")

try { $d = Invoke-RestMethod -Uri "$api/discover"; Check "discover" ($d.protocol -eq "2026-07-28") $d.protocol }
catch { Check "discover" $false $_ }
try { $t = Invoke-RestMethod -Uri "$api/tools"; Check "tools-list-22" ($t.tools.Count -eq 22) ("count=" + $t.tools.Count) }
catch { Check "tools-list-22" $false $_ }

# status + real payload verification (not just resultType)
try {
  $r = McpCall "ape_status" @{}
  $eng = $r.structuredContent.result.engines
  Check "status-engines" ($r.resultType -eq "complete" -and $eng.genesis -eq "vendored" -and $eng.adam -eq "vendored") ""
} catch { Check "status-engines" $false $_ }

# remember actually stores via real vendored adam-mcp (returns memory id)
try {
  $r = McpCall "ape_remember" @{ kind = "episodic"; content = "live-audit-marker-42"; origin = "observation"; confidence = 0.9 }
  $res = $r.structuredContent.result
  Check "remember-payload" ($res._adam -eq "ok" -and $res.result[0].text -match "id") ""
} catch { Check "remember-payload" $false $_ }

# recall a real query against the stored memory
try {
  $r = McpCall "ape_recall" @{ query = "live-audit-marker-42"; top_k = 3 }
  $res = $r.structuredContent.result
  Check "recall-payload" ($res._adam -eq "ok" -and ($res.result[0].text -match "live-audit-marker-42")) ""
} catch { Check "recall-payload" $false $_ }

# skein orchestrate status (real engine call via PYTHONPATH unavailable in job; still routes)
try {
  $r = McpCall "ape_orchestrate" @{ op = "status" }
  Check "orchestrate-status" ($r.resultType -eq "complete") ""
} catch { Check "orchestrate-status" $false $_ }

# MRTR confirm for destructive evolve — REAL payload (was broken by $args bug)
try {
  $r = McpCall "ape_evolve" @{ action = "accept"; proposal_id = "p-live" }
  Check "mrtr-confirm" ($r.resultType -eq "input_required" -and $r.requestState -and ($r.inputRequests[0].message -match "destructive")) ""
} catch { Check "mrtr-confirm" $false $_ }

# background task lifecycle â€” REAL nested tool+arguments
try {
  $r = McpCall "ape_task_start" @{ tool = "ape_status"; arguments = @{} }
  $id = $r.structuredContent.result.task_id
  $ok = $false
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 500
    $g = Invoke-RestMethod -Uri "$api/tasks/get" -Method Post -Body (@{ task_id = $id } | ConvertTo-Json -Compress) -ContentType "application/json"
    if ($g.task.status -eq "done") { $ok = $true; break }
    if ($g.task.status -eq "failed") { break }
  }
  Check "task-lifecycle" $ok ("id=" + $id)
} catch { Check "task-lifecycle" $false $_ }

# unknown tool honest error
try {
  $r = McpCall "ape_nonexistent" @{}
  Check "unknown-tool" ($r.structuredContent.result.error -eq "unknown_tool") ""
} catch { Check "unknown-tool" $false $_ }

# agent run lifecycle — mock profile run via MCP, poll to done, ledger populated
try {
  $script = @(@{ tool = "skein.orchestrate"; args = @{ op = "status" } }, @{ tool = "finish"; args = @{ summary = "live-agent-ok" } }) | ConvertTo-Json -Depth 6 -Compress
  $r = McpCall "ape_agent_run" @{ profile = "repo-triage"; objective = "Live agent gate."; _mockScript = @($script | ConvertFrom-Json) }
  $runId = $r.structuredContent.result.run_id
  $ok = $false
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 250
    $g = Invoke-RestMethod -Uri "$api/call" -Method Post -Body (@{ name = "ape_agent_status"; arguments = @{ run_id = $runId } } | ConvertTo-Json -Compress) -ContentType "application/json" -Headers @{ "Mcp-Method" = "tools/call" }
    if ($g.structuredContent.result.status -eq "done") { $ok = $true; break }
    if ($g.structuredContent.result.status -eq "failed") { break }
  }
  Check "agent-run-lifecycle" $ok ("run=" + $runId)
} catch { Check "agent-run-lifecycle" $false $_ }

# header mismatch rejection
try {
  $body = @{ name = "ape_status"; arguments = @{} } | ConvertTo-Json -Compress
  $null = Invoke-RestMethod -Uri "$api/call" -Method Post -Body $body -ContentType "application/json" -Headers @{ "Mcp-Method" = "wrong/method" }
  Check "header-mismatch" $false "no rejection"
} catch { Check "header-mismatch" ($_.ToString() -match "400") "400 rejected" }

try { $w = Invoke-RestMethod -Uri "$api/.well-known/oauth-protected-resource"; Check "well-known" ($w.ape_mode -eq "local-open") "" }
catch { Check "well-known" $false $_ }

# A2A bridge: agent card + message/send + tasks/get over HTTP
try {
  $card = Invoke-RestMethod -Uri "$api/.well-known/agent.json"
  Check "a2a-card" ($card.name -eq "ape-mcp" -and $card.skills.Count -ge 3) ("skills=" + $card.skills.Count)
} catch { Check "a2a-card" $false $_ }
try {
  $am = @{ jsonrpc = "2.0"; id = 31; method = "message/send"; params = @{ message = @{ role = "user"; parts = @(@{ kind = "text"; text = "audit ping" }); messageId = "m-audit" }; metadata = @{ profile = "repo-triage" } } } | ConvertTo-Json -Depth 6 -Compress
  $at = Invoke-RestMethod -Uri "$api/a2a" -Method Post -Body $am -ContentType "application/json"
  $ag = Invoke-RestMethod -Uri "$api/a2a" -Method Post -Body (@{ jsonrpc = "2.0"; id = 32; method = "tasks/get"; params = @{ id = $at.result.id } } | ConvertTo-Json -Compress) -ContentType "application/json"
  Check "a2a-lifecycle" ($at.result.id -and $ag.result.id -eq $at.result.id) ("task=" + $at.result.id)
} catch { Check "a2a-lifecycle" $false $_ }

try {
  $resp = echo '{"jsonrpc":"2.0","id":9,"method":"tools/list","params":{}}' | node $root\bin\ape-mcp.js
  Check "stdio" ($resp -match "ape_status") ""
} catch { Check "stdio" $false $_ }

$ju = Start-Job -ArgumentList $root -ScriptBlock {
  param($repoRoot)
  Set-Location $repoRoot
  node bin/ape-mcp.js serve --no-open
}
Start-Sleep -Seconds 3
try {
  $out = Receive-Job -Job $ju 2>&1 | Out-String
  if ($out -match "(http://127\.0\.0\.1:\d+/)") {
    $curl = $Matches[1]
    $pg = Invoke-WebRequest -Uri $curl -UseBasicParsing
    Check "console-page" ($pg.StatusCode -eq 200 -and $pg.Content -match "APE") $curl
    $tr = Invoke-RestMethod -Uri ($curl + "api/trace?since=0")
    Check "console-trace" ($tr.count -gt 0) ("events=" + $tr.count)
    $tk = Invoke-RestMethod -Uri ($curl + "api/tasks")
    Check "console-tasks" ($null -ne $tk.tasks) ""
    $rn = Invoke-RestMethod -Uri ($curl + "api/runs")
    Check "console-runs" ($null -ne $rn.runs) ("runs=" + $rn.runs.Count)
    $sp = Invoke-RestMethod -Uri ($curl + "api/spend")
    Check "console-spend" ($null -ne $sp.today_usd) ("today=$" + $sp.today_usd)
    $md = Invoke-RestMethod -Uri ($curl + "api/mods")
    Check "console-mods" (($md.mods | Where-Object { $_.name -eq "policy-gates" }).preCall -eq $true) "policy-gates preCall live"
    $gr = Invoke-RestMethod -Uri ($curl + "api/graph")
    Check "console-graph" ($null -ne $gr.graph -and $gr.graph.op -eq "graph") "skein graph live"
    $ex = Invoke-RestMethod -Uri ($curl + "api/experience")
    Check "console-experience" ($null -ne $ex.runs) "eve runs live"
  } else { Check "console-page" $false "no URL in output" }
} catch { Check "console-page" $false $_.ToString().Substring(0, [Math]::Min(120, $_.ToString().Length)) }

Stop-Job $jm, $ju -ErrorAction SilentlyContinue; Remove-Job $jm, $ju -Force -ErrorAction SilentlyContinue
$failed = @($results | Where-Object { -not $_.pass })
Write-Output ("--- LIVE AUDIT: {0}/{1} passed ---" -f ($results.Count - $failed.Count), $results.Count)
if ($failed.Count -gt 0) { exit 1 }