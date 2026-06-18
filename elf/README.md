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
pipeline + on-disk cache). Rate is applied client-side via
`<audio>.playbackRate`, so it is not baked into synthesis or the cache key.

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
