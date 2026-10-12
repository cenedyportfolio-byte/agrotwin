# Runs a command in the GPU venv with CUDA + MSVC on PATH, so gsplat can
# JIT-compile its kernels. Everything this project writes — package caches,
# compiled kernels, temp files, logs — is kept under this folder on E:; only
# system-level tools (Python, CUDA toolkit, VS Build Tools) live on C:.
#   .\run_gpu.ps1 -m scripts.build_splats --survey <id>
$root = $PSScriptRoot
$vsBuild = "C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC"
$vcvars = "$vsBuild\Auxiliary\Build\vcvars64.bat"
$vsInstaller = "C:\Program Files (x86)\Microsoft Visual Studio\Installer"
# newest installed toolkit / toolset: the versions differ between machines
$cudaHome = (Get-ChildItem "C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA" -Directory |
  Sort-Object { [version]($_.Name.TrimStart("v")) } | Select-Object -Last 1).FullName
$venvScripts = "$root\backend\.venv-gpu\Scripts"
$msvcVer = (Get-ChildItem "$vsBuild\Tools\MSVC" -Directory | Sort-Object { [version]$_.Name } | Select-Object -Last 1).Name
$msvcBin = "$vsBuild\Tools\MSVC\$msvcVer\bin\Hostx64\x64"
$cache = "$root\.cache"
foreach ($d in "$cache\tmp", "$cache\uv", "$cache\pip", "$cache\torch_extensions", "$root\logs") { New-Item -ItemType Directory -Force -Path $d | Out-Null }

$argline = ($args | ForEach-Object { if ($_ -match '\s') { "`"$_`"" } else { $_ } }) -join ' '
# PYTHONUTF8: piped stdout defaults to cp1252 on Windows and chokes on the tiler's "≈"
# CL: CUDA 13.2's CCCL headers refuse MSVC's traditional preprocessor (#error C1189)
$env = "set PYTHONUTF8=1&& set CL=/Zc:preprocessor&& set TEMP=$cache\tmp&& set TMP=$cache\tmp&& set UV_CACHE_DIR=$cache\uv&& set PIP_CACHE_DIR=$cache\pip&& set TORCH_EXTENSIONS_DIR=$cache\torch_extensions"
cmd /c "set PATH=$vsInstaller;%PATH%&& call `"$vcvars`" && $env&& set CUDA_HOME=$cudaHome&& set CUDA_PATH=$cudaHome&& set PATH=$venvScripts;$msvcBin;$cudaHome\bin;%PATH%&& cd /d `"$root\backend`" && `"$venvScripts\python.exe`" $argline"
exit $LASTEXITCODE
