# Copies pinned CPython 3.12 stdlib files into test/python-oracle/real-world
# and writes manifest.json as UTF-8 without a BOM.
# Run from the repository root:
#   powershell -ExecutionPolicy Bypass -File .\copy-real-world.ps1
$ErrorActionPreference = 'Stop'

$version = (& py -3.12 -c "import sys; print(sys.version.split()[0])").Trim()
if ($version -notlike '3.12.*') { throw "Expected Python 3.12.x, got $version" }

$stdlib = (& py -3.12 -c "import sysconfig; print(sysconfig.get_paths()['stdlib'])").Trim()
$prefix = (& py -3.12 -c "import sys; print(sys.base_prefix)").Trim()
$license = Join-Path $prefix 'LICENSE.txt'
if (-not (Test-Path $license)) { throw "PSF license not found at $license" }

$picks = @(
  'argparse.py', 'dataclasses.py', 'pathlib.py', 'enum.py', 'functools.py',
  'json\decoder.py', 'json\encoder.py', 'asyncio\tasks.py', 'typing.py', 'shutil.py'
)

$dest = Join-Path (Get-Location) 'test\python-oracle\real-world'
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item $license (Join-Path $dest 'LICENSE-PSF.txt') -Force

$entries = foreach ($rel in $picks) {
  $src = Join-Path $stdlib $rel
  $name = $rel -replace '\\', '__'
  Copy-Item $src (Join-Path $dest $name) -Force
  [pscustomobject]@{
    path    = $name
    sha256  = (Get-FileHash -Algorithm SHA256 (Join-Path $dest $name)).Hash.ToLower()
    source  = $src
    license = 'PSF-2.0'
    python  = $version
  }
}

$json = ($entries | ConvertTo-Json -Depth 3) + "`n"
[System.IO.File]::WriteAllText((Join-Path $dest 'manifest.json'), $json, (New-Object System.Text.UTF8Encoding $false))
Write-Host "Copied $($entries.Count) files from Python $version to $dest"