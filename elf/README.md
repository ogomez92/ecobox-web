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
├── lib/            eci.so + per-language modules (en, es, fr, de, it, pt, fi)
├── bin/eci_synth   one-shot synthesizer the Node adapter spawns
└── src/            C sources for eci_synth (build with `make`)
```

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
in `engine_open` (`src/eci/engine.c`) and are deliberately not configurable:

- `eciSetParam(eciDictionary, 1)` — disables abbreviation expansion, so `Dr.`,
  `St.`, `lbs.` etc. are read as written rather than expanded. This affects only
  the abbreviation dictionaries (internal + user), not the main/root
  pronunciation dictionaries.
- `eciSetParam(eciPhrasePrediction, 0)` — disables phrase prediction.

Polarity follows the IBM 6.x ABI (dictionary `0`=enabled/`1`=disabled; phrase
prediction `0`=off). `eciPhrasePrediction` is param `11` (see `src/eci/eci.h`).
Because these are baked into the binary they are not part of the audio-cache
key, so clear the TTS cache to re-synthesize already-cached audio.

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

## Rebuilding `eci_synth`

Needed after a fresh checkout on a new machine, a CPU-arch change, or any edit to
`eci_synth.c` / the `eci/` wrapper:

```bash
cd elf/src && make        # -> ../bin/eci_synth
```

Build needs `cc` and the standard C toolchain. Runtime needs `libc++` /
`libc++abi` and `ffmpeg` (already present on this host).

## Licensing

- `src/eci/**` and `src/eci_synth.c` are GPL-2.0-or-later (see `src/LICENSE.GPL`),
  derived from an upstream speech-dispatcher ECI module.
- `lib/*.so` are derivative works of the original vendor's ECI dylibs, subject to
  that SDK's terms — kept here for this self-hosted install, not for redistribution.
