[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'

$BaseDir = $PSScriptRoot
$PyDir = Join-Path $BaseDir 'python'
$PyExe = Join-Path $PyDir 'python.exe'
$DataModelsDir = Join-Path $BaseDir 'data\models'

if (Test-Path $PyExe) {
  Write-Host "[확인] 이미 포터블 Python 환경이 설치되어 있습니다: $PyDir"
  exit 0
}

Write-Host ""
Write-Host "=== Lyriko AI 로컬 GPU 환경 최초 설정 ===" -ForegroundColor Cyan
Write-Host "모든 파일은 이 폴더 내부에만 설치됩니다: $PyDir"
New-Item -ItemType Directory -Path $PyDir -Force | Out-Null
New-Item -ItemType Directory -Path $DataModelsDir -Force | Out-Null

$PyZipUrl = 'https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-amd64.zip'
$PyZipPath = Join-Path $PyDir 'python-embed.zip'

Write-Host "[1/4] Python 3.11 포터블 런타임 다운로드 중..."
Invoke-WebRequest -Uri $PyZipUrl -OutFile $PyZipPath -UseBasicParsing
Expand-Archive -Path $PyZipPath -DestinationPath $PyDir -Force
Remove-Item $PyZipPath -Force

# Enable site-packages & Scripts lookup inside embeddable python311._pth
$PthFile = Join-Path $PyDir 'python311._pth'
if (Test-Path $PthFile) {
  $pthLines = Get-Content $PthFile
  $updated = @()
  foreach ($line in $pthLines) {
    if ($line -match '^#\s*import site') {
      $updated += 'import site'
    } else {
      $updated += $line
    }
  }
  if (-not ($updated -contains 'Lib\site-packages')) {
    $updated += 'Lib\site-packages'
  }
  Set-Content -Path $PthFile -Value $updated -Encoding ASCII
}

Write-Host "[2/4] pip 패키지 관리자 설치 중..."
$GetPipPath = Join-Path $PyDir 'get-pip.py'
Invoke-WebRequest -Uri 'https://bootstrap.pypa.io/get-pip.py' -OutFile $GetPipPath -UseBasicParsing
& $PyExe $GetPipPath --no-warn-script-location
if ($LASTEXITCODE -ne 0) { throw "pip 설치 실패 (exit code $LASTEXITCODE)" }
Remove-Item $GetPipPath -Force

$HasNvidia = $false
try {
  $smi = & nvidia-smi --query-gpu=name --format=csv,noheader 2>$null
  if ($LASTEXITCODE -eq 0 -and $smi) {
    $HasNvidia = $true
    Write-Host "[감지됨] NVIDIA GPU: $($smi | Select-Object -First 1)" -ForegroundColor Green
  }
} catch {
  $HasNvidia = $false
}

Write-Host "[3/4] PyTorch & Torchaudio 설치 중 ($(if ($HasNvidia) { 'CUDA GPU 가속' } else { 'CPU 모드' }))..."
if ($HasNvidia) {
  & $PyExe -m pip install --prefer-binary --no-warn-script-location torch torchaudio --index-url https://download.pytorch.org/whl/cu124
} else {
  & $PyExe -m pip install --prefer-binary --no-warn-script-location torch torchaudio
}
if ($LASTEXITCODE -ne 0) { throw "PyTorch/Torchaudio 설치 실패 (exit code $LASTEXITCODE)" }

Write-Host "[4/4] 오디오 처리 및 AI 보컬 분리/싱크 패키지 설치 중..."
$ortPkg = if ($HasNvidia) { 'onnxruntime-gpu' } else { 'onnxruntime' }
& $PyExe -m pip install --prefer-binary --no-warn-script-location numpy scipy soundfile $ortPkg audio-separator
if ($LASTEXITCODE -ne 0) { throw "AI 오디오 패키지 설치 실패 (exit code $LASTEXITCODE)" }

Write-Host ""
Write-Host "포터블 Python AI 환경 준비 완료!" -ForegroundColor Green
