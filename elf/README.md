# Bundled ELF TTS engine

This directory makes ecobox self-contained for the **ELF** TTS provider: a
classic on-device ECI (6.1) voice synthesized entirely on this server — no API
key, no network. It's wired in as a keyless audio service alongside
ElevenLabs / Azure / Google (see `src/server/services/tts/elf.ts`).

The engine is a set of ECI (`TextToSpeechKona`) dylibs ported to Linux ELF by an
upstream community project; only the converted shared objects and a thin wrapper
are vendored here. See `src/LICENSE.GPL` for the upstream notice and provenance.

## Layout

```
elf/
├── lib/                eci.so + per-language modules (en, es, fr, de, it, pt, fi)
├── lib-win32/          eci.dll + the same languages as .syn modules, + eci.ini
├── bin/eci_synth       one-shot synthesizer the Node adapter spawns (POSIX)
├── bin/eci_synth.exe   the same tool, built 32-bit for Windows
└── src/                C sources for eci_synth (`make`, or build-win32.ps1)
```

Both builds come from the same sources and expose the same CLI, so the Node adapter
only picks a different executable and module directory (`elf.ts`); nothing else in
the app knows which engine build it is talking to. The pronunciation dictionaries in
`lib/dictionaries/` are shared by both — they are plain text, and identical.

CJK languages (ja/ko/zh) are intentionally **not** shipped — the converted CJK
modules crash mid-utterance, so they're gated out (same as the upstream
speech-dispatcher module).

## How it's used at runtime

`src/server/services/tts/elf.ts` spawns one `eci_synth` process per synthesis
unit:

```
echo "text…" | bin/eci_synth --lib-dir lib --voice-id "Reed-en-US"   # -> WAV on stdout
bin/eci_synth --list                                                  # -> JSON voice catalogue
```

The adapter pipes the WAV through `ffmpeg` to MP3 (to match the audio/mpeg
pipeline + on-disk cache).

### Reading rate

`eci_synth` accepts `--rate M`, a playback-speed multiplier (1.0 = the preset's
natural pace). Unlike the other audio providers — which time-stretch the MP3
client-side via `<audio>.playbackRate` — ELF bakes the speed into synthesis using
the engine's native `eciSpeed`, so this formant voice stays crisp when sped up
(client-side stretching smears consonants). `eciSpeed` is ~logarithmic in
perceived rate, so the multiplier→eciSpeed map is an empirical fit
(`rate_to_eci_speed` in `eci_synth.c`: `eciSpeed ≈ 50 + ln(M)/0.019`, clamped
0..250) chosen so synthesized duration scales ~1/M over the reader's 0.5..5×
range. Because rate now changes the samples, ecobox folds it into the on-disk
audio-cache key for ELF (so changing speed re-synthesizes). To re-calibrate after
an engine/voice change: synthesize a fixed phrase at several `--rate` values,
measure WAV duration, and re-fit the `0.019` slope.

### Voice parameters

`eci_synth` accepts optional 0..100 overrides for the active voice, applied on
top of the chosen preset via `SetVoiceParam`:

```
--head-size N --pitch N --inflection N --roughness N --breathiness N --volume N
```

ecobox exposes these in Settings behind a "Customize voice" toggle and persists
them on the `tts_credentials` row (`elf_*` columns). When customized, they fold
into the audio-cache key so re-tuning re-synthesizes. **Volume is always applied
and defaults to 100** (loudest) even when the other knobs are left at the preset.

### Text handling

The engine's two "guessing" text passes are forced **off** for every synthesis
and are deliberately not configurable:

- **Abbreviation expansion** — `eciSetParam(eciDictionary, 1)` in `engine_open`
  (`src/eci/engine.c`), so `Dr.`, `St.`, `lbs.` etc. are read as written rather
  than expanded. This affects only the abbreviation dictionaries (internal +
  user), not the main/root pronunciation dictionaries. Polarity per the IBM 6.x
  ABI: `0`=enabled, `1`=disabled. This one works — the engine's default is `0`
  and `GetParam` confirms the flip to `1`.
- **Phrase prediction** (guessed prosodic phrase breaks in unpunctuated text) —
  disabled by prepending the inline ECI directive `` `pp0 `` to the input text in
  the adapter (`PHRASE_PREDICTION_OFF` in `src/server/services/tts/elf.ts`). The
  engine honors it through the `eciInputType=1` backquote channel, the same path
  the pronunciation dictionary rides on. **`eciSetParam(eciPhrasePrediction, 0)`
  does NOT work in this port** — `GetParam` round-trips the value but synthesis is
  byte-identical at `0` or `1` (the `SetParam` call is left in `engine_open` only
  as a belt-and-suspenders intent marker). The inline `` `pp0 `` genuinely changes
  the output; this mirrors the upstream Eloquence driver, which embeds
  `` `pp1 ``/`` `pp0 `` in its byte stream.

Neither setting is part of the audio-cache key (the abbreviation flag is baked
into the binary; the `` `pp0 `` prefix is added after the cache hash is computed),
so **clear the TTS cache to re-synthesize already-cached audio** — older ELF audio
was synthesized with phrase prediction still on.

### Pronunciation dictionaries

Custom pronunciations live in `lib/dictionaries/` as eloquence_threshold-style
TSV files named by ECI langid: `<langid>main.dic`, `<langid>root.dic`,
`<langid>abbr.dic` (e.g. `enumain.dic`, `espmain.dic`). Each line is
`key<TAB>replacement`; the replacement may carry ECI backtick annotations
(`` `1 `` stress, `` `[…] `` phonemes) which the engine interprets from input
text.

These are applied by **ecobox**, not the engine: the native `LoadDict`/`SetDict`
path is non-functional in this port (entries are silently ignored, and loading
an edited `.dic` segfaults `eci_synth`), so `src/server/services/tts/elfDict.ts`
performs the substitution on the input text before synthesis. The dictionary is
chosen by the **language of the voice in use** (parsed from the voiceId, e.g.
`Reed-en-US` → `enu`), not the book's language. Matching is case-sensitive and
whole-word; all three volumes apply. Edits are picked up live (mtime-checked) and
re-synthesize via the audio cache automatically — no rebuild needed (these files
are runtime data, not compiled into `eci_synth`).

The bundle location is `ELF_DIR` (`.env`), defaulting to `<cwd>/elf`.

## The Windows build

`lib-win32/` is not a conversion: it is the **original** ECI 6.1 runtime for Windows
(`eci.dll` plus the `.syn` language modules), which is where this engine started life.
The same `src/` builds against it, guarded by `#ifdef _WIN32`. Five things differ, and
all five are load-bearing:

1. **Calling convention.** The Windows entry points are `__stdcall`; the POSIX ports
   are cdecl. Verified by disassembly rather than assumed — `eciAddText` takes two
   4-byte arguments and ends in `ret $0x8`, so the callee pops them. This is what the
   `ECI_CALL` macro in `eci/eci.h` carries, and it applies to the whole `EciApi` table
   *and* to `ECICallback`, which the engine calls back into us. A mismatch neither
   fails to link nor warns; it just unbalances the stack and crashes elsewhere.

2. **32-bit.** `eci.dll` is i386, so `eci_synth.exe` must be i686 too — a 64-bit
   process cannot load a 32-bit DLL. Node (x64) spawning a 32-bit child is fine.

3. **Two entry points are missing.** The Windows DLL does not export
   `eciGetDefaultParam` / `eciSetDefaultParam`, though IBM documents them. Nothing
   calls them, so `runtime.c` resolves them with `LOAD_OPT` instead of rejecting the
   whole runtime.

4. **`eciSynchronize` blocks, and `eciSpeaking` afterwards is not Boolean.** Every
   sample is already delivered when `Synchronize` returns, and `Speaking` then reports
   a truthy non-Boolean value. The POSIX drain loop that waits on it is therefore
   compiled out on Windows: it would never see a reason to stop, and at Windows'
   ~15 ms timer granularity its nominal 1 ms sleeps turn 20000 iterations into about
   five minutes per sentence.

5. **The INI and the text encoding.** The engine finds `eci.ini` through the registry,
   then the `ECIINI` environment variable, then the current directory; we set the
   variable and chdir, so nothing outside the process is touched and no registry write
   is needed. `eci_synth` copies the shipped `lib-win32/eci.ini` into its work dir and
   rewrites only the `Path=` / `Path_Rom=` entries — the file also carries
   `CallbackFlag`, the eight voice-preset rows and the phoneme tables, which a
   generated minimal INI would silently drop. Text conversion uses
   `MultiByteToWideChar`/`WideCharToMultiByte` instead of iconv (mingw has none), with
   best-fit mapping standing in for `//TRANSLIT`. stdin and stdout are switched to
   binary mode — otherwise LF→CRLF translation corrupts every WAV containing `0x0A`.

CJK stays gated out on Windows too. The original modules presumably lack the defect
that breaks the converted ones, but they also need their `*rom.dll` romanizers and a
different input encoding, so they are untested here; `ibmtts/`-style bundles ship the
files if anyone wants to try.

## Rebuilding `eci_synth`

Needed after a fresh checkout on a new machine, a CPU-arch change, or any edit to
`eci_synth.c` / the `eci/` wrapper:

```bash
cd elf/src && make        # -> ../bin/eci_synth
```

Build needs `cc` and the standard C toolchain. Runtime needs `libc++` /
`libc++abi` and `ffmpeg` (already present on this host).

On Windows, `eci_synth.exe` is committed, so a normal checkout needs no toolchain at
all. To rebuild it you need an **i686** mingw-w64 gcc (the x86_64 one cannot produce a
32-bit binary; the script checks and refuses rather than emitting one that could never
load the DLL). The portable i686 WinLibs zip works:

```powershell
cd elf\src
.\build-win32.ps1 -Cc C:\tools\mingw32\bin\gcc.exe    # -> ..\bin\eci_synth.exe
```

## Licensing

- `src/eci/**` and `src/eci_synth.c` are GPL-2.0-or-later (see `src/LICENSE.GPL`),
  derived from an upstream speech-dispatcher ECI module.
- `lib/*.so` are derivative works of the original vendor's ECI dylibs, subject to
  that SDK's terms — kept here for this self-hosted install, not for redistribution.
