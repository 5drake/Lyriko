[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch {}

$BaseDir = $PSScriptRoot
$NodeDir = Join-Path $BaseDir 'node'
$NodeExe = Join-Path $NodeDir 'node.exe'
$DlDir = Join-Path $NodeDir '_dl'
$TmpExe = Join-Path $DlDir 'node.exe'

if (Test-Path $NodeExe) {
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  & $NodeExe -e "process.exit(Number(process.versions.node.split('.')[0])>=20?0:1)" 2>$null | Out-Null
  $probeOk = ($LASTEXITCODE -eq 0)
  $ErrorActionPreference = $prevEap
  if ($probeOk) {
    Write-Host "[확인] 이미 포터블 Node.js가 준비되어 있습니다: $NodeExe" -ForegroundColor Green
    exit 0
  }
}

try {
  New-Item -ItemType Directory -Path $NodeDir -Force | Out-Null
  New-Item -ItemType Directory -Path $DlDir -Force | Out-Null
  if (Test-Path $TmpExe) {
    Remove-Item $TmpExe -Force -ErrorAction SilentlyContinue
  }

  $latestSha = $null
  $versionLabel = 'v22 LTS'
  try {
    $shaResp = Invoke-WebRequest -Uri 'https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt' -UseBasicParsing -TimeoutSec 15
    $shaContent = [string]$shaResp.Content
    if ($shaContent -match '(?m)^([0-9a-fA-F]{64})\s+win-x64/node\.exe\s*$') {
      $latestSha = $Matches[1].ToLowerInvariant()
    }
    if ($shaContent -match '(?m)node-(v22\.\d+\.\d+)-win-x64\.zip') {
      $versionLabel = $Matches[1]
    }
  } catch {
    # SHASUMS256 lookup failed; fallback candidate below includes a pinned SHA-256
  }

  Write-Host ""
  Write-Host "=== Lyriko 포터블 Node.js ($versionLabel) 자동 설치 ===" -ForegroundColor Cyan
  Write-Host "모든 파일은 이 폴더 내부에만 저장됩니다: $NodeDir"

  $candidates = @(
    @{ Url = 'https://nodejs.org/dist/latest-v22.x/win-x64/node.exe'; Sha256 = $latestSha },
    @{ Url = 'https://nodejs.org/dist/v22.23.5/win-x64/node.exe'; Sha256 = '247e9693d316da9857e44990e5e11709f596f18112251b8026ec6eed80bdf38a' }
  )

  $curlCmd = Get-Command curl.exe -ErrorAction SilentlyContinue
  $verifiedOk = $false
  $detectedVer = ''
  $lastFailure = '다운로드 시도 실패'

  foreach ($candidate in $candidates) {
    $url = $candidate.Url
    $expectedSha = $candidate.Sha256
    if (Test-Path $TmpExe) {
      Remove-Item $TmpExe -Force -ErrorAction SilentlyContinue
    }

    Write-Host "[1/2] 공식 포터블 Node.js 다운로드 중... ($url)"
    $downloaded = $false

    if ($curlCmd) {
      $prevEap = $ErrorActionPreference
      $ErrorActionPreference = 'Continue'
      & $curlCmd.Source -fL --retry 2 --connect-timeout 15 --progress-bar -o $TmpExe $url
      $curlExit = $LASTEXITCODE
      $ErrorActionPreference = $prevEap
      if ($curlExit -eq 0 -and (Test-Path $TmpExe)) {
        $downloaded = $true
      } else {
        Remove-Item $TmpExe -Force -ErrorAction SilentlyContinue
      }
    }

    if (-not $downloaded) {
      try {
        Invoke-WebRequest -Uri $url -OutFile $TmpExe -UseBasicParsing -TimeoutSec 120
        if (Test-Path $TmpExe) {
          $downloaded = $true
        }
      } catch {
        $lastFailure = $_.Exception.Message
        Remove-Item $TmpExe -Force -ErrorAction SilentlyContinue
      }
    }

    if (-not $downloaded -or -not (Test-Path $TmpExe)) {
      $lastFailure = "파일 다운로드 실패: $url"
      continue
    }

    $fileLen = (Get-Item $TmpExe).Length
    if ($fileLen -le 20MB) {
      $lastFailure = "다운로드된 파일 크기가 비정상적입니다 ($fileLen bytes)."
      Remove-Item $TmpExe -Force -ErrorAction SilentlyContinue
      continue
    }

    Write-Host "[2/2] 무결성(SHA-256) 및 실행 확인 중..."
    if ($expectedSha) {
      $actualSha = (Get-FileHash -Path $TmpExe -Algorithm SHA256).Hash.ToLowerInvariant()
      if ($actualSha -ne $expectedSha) {
        $lastFailure = "SHA-256 해시 불일치 ($actualSha != $expectedSha)"
        Remove-Item $TmpExe -Force -ErrorAction SilentlyContinue
        continue
      }
    }

    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $verRaw = & $TmpExe -v 2>$null
    $verExit = $LASTEXITCODE
    $verOut = ("$verRaw").Trim()
    & $TmpExe -e "process.exit(Number(process.versions.node.split('.')[0])>=20?0:1)" 2>$null | Out-Null
    $majorExit = $LASTEXITCODE
    $ErrorActionPreference = $prevEap

    if ($verExit -ne 0 -or $majorExit -ne 0) {
      $lastFailure = "다운로드한 node.exe 버전 확인 실패 ($verOut)"
      Remove-Item $TmpExe -Force -ErrorAction SilentlyContinue
      continue
    }

    $detectedVer = $verOut
    $verifiedOk = $true
    break
  }

  if (-not $verifiedOk) {
    throw $lastFailure
  }

  Move-Item -Path $TmpExe -Destination $NodeExe -Force
  Remove-Item $DlDir -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host "[완료] 포터블 Node.js ($detectedVer) 준비 완료: $NodeExe" -ForegroundColor Green
  exit 0
} catch {
  Remove-Item $DlDir -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host ""
  Write-Host "[오류] 포터블 Node.js 자동 다운로드에 실패했습니다: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "방화벽·네트워크 제한 환경에서는 아래 방법으로 Node.js 20+ LTS를 수동 설치한 뒤 다시 실행해 주세요:" -ForegroundColor Yellow
  Write-Host "  1) 공식 사이트: https://nodejs.org (LTS 버전 다운로드 후 설치)"
  Write-Host "  2) 터미널 명령어: winget install OpenJS.NodeJS.LTS"
  Write-Host "  3) 수동 포터블 배치: node.exe 파일을 `"$NodeExe`" 위치에 복사"
  exit 1
}
