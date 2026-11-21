param(
  [switch]$IncludeNode
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$RootDir = Split-Path -Parent $PSScriptRoot
$DistDir = Join-Path $RootDir 'dist'
$StageDir = Join-Path $DistDir 'Lyriko-Worker-Portable'
$ZipPath = Join-Path $DistDir 'Lyriko-Worker-Portable.zip'

Write-Host "=== Building Lyriko Portable Worker Package ===" -ForegroundColor Cyan

if (Test-Path $StageDir) { Remove-Item $StageDir -Recurse -Force }
if (Test-Path $ZipPath) { Remove-Item $ZipPath -Force }
New-Item -ItemType Directory -Path $StageDir -Force | Out-Null

# Copy server (excluding local user data, binaries, dev ai-env)
$StageServer = Join-Path $StageDir 'server'
$null = robocopy (Join-Path $RootDir 'server') $StageServer /E /XD data ai-env bin __pycache__ /NFL /NDL /NJH /NJS

# Copy shared + package.json
$null = robocopy (Join-Path $RootDir 'shared') (Join-Path $StageDir 'shared') /E /NFL /NDL /NJH /NJS
Copy-Item (Join-Path $RootDir 'package.json') (Join-Path $StageDir 'package.json') -Force

# Copy worker launcher & docs
Copy-Item (Join-Path $PSScriptRoot 'Lyriko-Worker.bat') (Join-Path $StageDir 'Lyriko-Worker.bat') -Force
Copy-Item (Join-Path $PSScriptRoot 'setup-ai-env.ps1') (Join-Path $StageDir 'setup-ai-env.ps1') -Force
Copy-Item (Join-Path $PSScriptRoot '완전삭제_안내.txt') (Join-Path $StageDir '완전삭제_안내.txt') -Force

# Optionally bundle host node.exe for true zero-prerequisite execution
if ($IncludeNode) {
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if ($nodeCmd) {
    $StageNode = Join-Path $StageDir 'node'
    New-Item -ItemType Directory -Path $StageNode -Force | Out-Null
    Copy-Item $nodeCmd.Source (Join-Path $StageNode 'node.exe') -Force
    Write-Host "Bundled node.exe from $($nodeCmd.Source)"
  }
}

# Copy runtime node_modules (excluding dev-only heavy toolchains)
$StageNm = Join-Path $StageDir 'node_modules'
$null = robocopy (Join-Path $RootDir 'node_modules') $StageNm /E /XD .vite .cache vite @vitejs tailwindcss @tailwindcss concurrently typescript /NFL /NDL /NJH /NJS

Write-Host "Compressing portable archive -> $ZipPath ..."
Compress-Archive -Path (Join-Path $StageDir '*') -DestinationPath $ZipPath -CompressionLevel Optimal

Write-Host "Done! Output: $ZipPath" -ForegroundColor Green
