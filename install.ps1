$ErrorActionPreference = "Stop"
# APE one-liner: iex (irm https://raw.githubusercontent.com/fernandogarzaaa/ape-mcp/main/install.ps1)
$dst = Join-Path $HOME ".ape\src"
if (Test-Path (Join-Path $dst ".git")) { git -C $dst pull --ff-only } else { git clone https://github.com/fernandogarzaaa/ape-mcp $dst }
Set-Location $dst
node --version
npm install --omit=dev
node bin/ape-mcp.js doctor
Write-Output "APE installed at $dst — run: node $dst/bin/ape-mcp.js"
