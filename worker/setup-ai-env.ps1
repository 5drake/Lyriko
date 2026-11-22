[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch {}

$BaseDir = $PSScriptRoot
$PyDir = Join-Path $BaseDir 'python'
$PyExe = Join-Path $PyDir 'python.exe'
$DataModelsDir = Join-Path $BaseDir 'data\models'

New-Item -ItemType Directory -Path $DataModelsDir -Force | Out-Null

$VerifyCode = "import torch, torchaudio; from audio_separator.separator import Separator; assert hasattr(torchaudio.pipelines, 'MMS_FA') and hasattr(torchaudio.pipelines, 'HDEMUCS_HIGH_MUSDB_PLUS'); print(torch.__version__, torch.cuda.is_available(), torchaudio.__version__)"

$NeedsPythonInstall = $true
if ((Test-Path $PyExe) -and (Test-Path (Join-Path $PyDir 'python311._pth'))) {
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  & $PyExe -c $VerifyCode 2>$null | Out-Null
  $probeOk = ($LASTEXITCODE -eq 0)
  $ErrorActionPreference = $prevEap
  if ($probeOk) {
    Write-Host "[확인] 이미 포터블 Python AI 환경이 정상 구성되어 있습니다: $PyDir" -ForegroundColor Green
    exit 0
  }
  Write-Host "[복구] PyTorch / Torchaudio 호환성 복구를 진행합니다..." -ForegroundColor Yellow
  $NeedsPythonInstall = $false
}

if ($NeedsPythonInstall) {
  Write-Host ""
  Write-Host "=== Lyriko AI 로컬 GPU 환경 최초 설정 ===" -ForegroundColor Cyan
  Write-Host "모든 파일은 이 폴더 내부에만 설치됩니다: $PyDir"
  New-Item -ItemType Directory -Path $PyDir -Force | Out-Null

  $PyZipUrl = 'https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-amd64.zip'
  $PyZipPath = Join-Path $PyDir 'python-embed.zip'

  Write-Host "[1/5] Python 3.11 포터블 런타임 다운로드 중..."
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
}

# Ensure pip works (re-install only if missing)
$prevEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
& $PyExe -m pip --version 2>$null | Out-Null
$hasPip = ($LASTEXITCODE -eq 0)
$ErrorActionPreference = $prevEap

if (-not $hasPip) {
  Write-Host "[2/5] pip 패키지 관리자 설치 중..."
  $GetPipPath = Join-Path $PyDir 'get-pip.py'
  Invoke-WebRequest -Uri 'https://bootstrap.pypa.io/get-pip.py' -OutFile $GetPipPath -UseBasicParsing
  $ErrorActionPreference = 'Continue'
  & $PyExe $GetPipPath --no-warn-script-location
  $pipExit = $LASTEXITCODE
  $ErrorActionPreference = 'Stop'
  if ($pipExit -ne 0) { throw "pip 설치 실패 (exit code $pipExit)" }
  Remove-Item $GetPipPath -Force -ErrorAction SilentlyContinue
}

$HasNvidia = $false
try {
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $smi = & nvidia-smi --query-gpu=name --format=csv,noheader 2>$null
  $smiExit = $LASTEXITCODE
  $ErrorActionPreference = $prevEap
  if ($smiExit -eq 0 -and $smi) {
    $HasNvidia = $true
    Write-Host "[감지됨] NVIDIA GPU: $($smi | Select-Object -First 1)" -ForegroundColor Green
  }
} catch {
  $HasNvidia = $false
}

Write-Host "[3/5] 오디오 처리 및 AI 보컬 분리 패키지 설치 중..."
$ortPkg = if ($HasNvidia) { 'onnxruntime-gpu' } else { 'onnxruntime' }
$ErrorActionPreference = 'Continue'
& $PyExe -m pip install --prefer-binary --no-warn-script-location numpy scipy soundfile $ortPkg audio-separator
$sepExit = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
if ($sepExit -ne 0) { throw "AI 오디오 패키지 설치 실패 (exit code $sepExit)" }

Write-Host "[4/5] PyTorch & Torchaudio 일치 버전 설치 중 ($(if ($HasNvidia) { 'CUDA 12.8 GPU 가속' } else { 'CPU 모드' }))..."
$ErrorActionPreference = 'Continue'
& $PyExe -m pip uninstall -y torch torchaudio torchvision 2>$null | Out-Null
if ($HasNvidia) {
  & $PyExe -m pip install --prefer-binary --no-warn-script-location torch torchaudio torchvision --index-url https://download.pytorch.org/whl/cu128
} else {
  & $PyExe -m pip install --prefer-binary --no-warn-script-location torch torchaudio torchvision
}
$torchExit = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
if ($torchExit -ne 0) { throw "PyTorch/Torchaudio 설치 실패 (exit code $torchExit)" }

Write-Host "[5/5] AI 보컬 분리/음소 정렬 환경 자가 점검 중..."
$ErrorActionPreference = 'Continue'
$verifyOut = & $PyExe -c $VerifyCode
$verifyExit = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
if ($verifyExit -ne 0) {
  throw "PyTorch/Torchaudio 자가 점검 실패 (exit code $verifyExit)"
}

Write-Host "확인 완료 ($verifyOut)" -ForegroundColor Green
Write-Host ""
Write-Host "포터블 Python AI 환경 준비 완료!" -ForegroundColor Green
