$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$RootDir = Split-Path -Parent $PSScriptRoot
$DistClient = Join-Path $RootDir 'dist\client'
$StageDir = Join-Path $RootDir 'dist\_gh_pages_stage'
$RepoUrl = 'https://github.com/5drake/Lyriko.git'

Write-Host '=== Building Lyriko client bundle ===' -ForegroundColor Cyan
Push-Location $RootDir
try {
  npm.cmd run build
  if ($LASTEXITCODE -ne 0) {
    throw "npm.cmd run build failed with exit code $LASTEXITCODE"
  }
} finally {
  Pop-Location
}

$IndexPath = Join-Path $DistClient 'index.html'
if (-not (Test-Path $IndexPath)) {
  throw "Expected build output missing: $IndexPath"
}

if (Test-Path $StageDir) {
  Remove-Item $StageDir -Recurse -Force
}
New-Item -ItemType Directory -Path $StageDir -Force | Out-Null

$null = robocopy $DistClient $StageDir /E /NFL /NDL /NJH /NJS
New-Item -ItemType File -Path (Join-Path $StageDir '.nojekyll') -Force | Out-Null

Write-Host '=== Publishing dist/client to gh-pages branch ===' -ForegroundColor Cyan
Push-Location $StageDir
try {
  git init -b gh-pages | Out-Null
  git config user.name '5drake'
  git config user.email '5drake@users.noreply.github.com'
  git add -A
  git commit -m 'Deploy Lyriko to GitHub Pages' | Out-Null
  git push --force $RepoUrl gh-pages
  if ($LASTEXITCODE -ne 0) {
    throw "git push to gh-pages failed with exit code $LASTEXITCODE"
  }
} finally {
  Pop-Location
  if (Test-Path $StageDir) {
    Remove-Item $StageDir -Recurse -Force
  }
}

Write-Host 'Done! Pushed dist/client to gh-pages.' -ForegroundColor Green
