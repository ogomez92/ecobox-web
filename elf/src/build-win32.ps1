# Build eci_synth.exe -- the one-shot synthesizer ecobox's ELF TTS provider
# spawns. Output: ..\bin\eci_synth.exe
#
# The Windows counterpart of `make` (see Makefile, which builds the POSIX
# binary). It is a plain script rather than a Makefile branch because a Windows
# box rarely has make, and GNU make's choice of shell there is a coin toss.
#
# IMPORTANT: the Windows ECI runtime (ECI.DLL, IBM/SpeechWorks ETI-Eloquence 6.1)
# is 32-bit x86. A 64-bit process cannot load a 32-bit DLL under any
# circumstances, so this MUST be built with an i686 mingw-w64 toolchain. The
# check below refuses to produce a binary that could never work -- using the
# x86_64 gcc is the easy mistake, and its failure mode otherwise shows up much
# later as an unhelpful "cannot load eci.dll".
#
# Usage:
#   .\build-win32.ps1                                    # i686-w64-mingw32-gcc from PATH
#   .\build-win32.ps1 -Cc C:\tools\mingw32\bin\gcc.exe   # explicit compiler

param(
    [string]$Cc = 'i686-w64-mingw32-gcc'
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

$resolved = (Get-Command $Cc -ErrorAction SilentlyContinue)
if (-not $resolved) {
    Write-Error @"
Compiler '$Cc' not found.

Install a 32-bit mingw-w64 toolchain and pass it with -Cc, e.g. the i686 WinLibs
build (portable zip):
  https://github.com/brechtsanders/winlibs_mingw/releases
  -> winlibs-i686-...-ucrt-....zip, extracted to e.g. C:\tools\mingw32
  .\build-win32.ps1 -Cc C:\tools\mingw32\bin\gcc.exe
"@
}
$cc = $resolved.Source

$target = & $cc -dumpmachine
if ($target -notmatch '^i686|^i386') {
    Write-Error @"
'$cc' targets '$target', but eci_synth.exe must be 32-bit x86 (i686) to load the
32-bit ECI.DLL. Point -Cc at an i686 mingw-w64 gcc.
"@
}

$sources = @(
    'eci_synth.c',
    'eci/runtime.c',
    'eci/engine.c',
    'eci/languages.c',
    'eci/voices.c'
)
$out = '../bin/eci_synth.exe'

New-Item -ItemType Directory -Force -Path '../bin' | Out-Null

Write-Host "Building $out with $cc ($target)"
& $cc -O2 -Wall -Wextra -o $out @sources -lm
if ($LASTEXITCODE -ne 0) { Write-Error "Compilation failed (exit $LASTEXITCODE)" }

Write-Host "OK -> $((Resolve-Path $out).Path)"
