# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Ecobox is a self-hosted audiobook and media player web application built with SvelteKit. It serves media files from a configurable directory, tracks playback position, supports chapters, bookmarks, and audio effects (EQ, compressor, reverb).

## Commands

```bash
# Development
npm run dev           # Start dev server on port 3000

# Build & Production
npm run build         # Build for production (output: ./build)
npm run preview       # Preview production build

# Type Checking
npm run check         # Run svelte-check (sync + type check)
npm run check:watch   # Watch mode for type checking

# Testing
npm run test          # Run unit tests with vitest
npm run test:e2e      # Run e2e tests with playwright (not configured yet)

# Run a single test file
npx vitest src/lib/utils/format.test.ts

# Database (Drizzle + SQLite)
npm run db:generate   # Generate migration from schema changes
npm run db:migrate    # Run migrations
npm run db:push       # Push schema directly (dev only)
npm run db:studio     # Open Drizzle Studio GUI
```

## Deployment on this machine

This working directory (`/home/ecobox`) is **also the production install**. The app runs as the `ecobox.service` systemd unit (`User=ecobox`, `WorkingDirectory=/home/ecobox`, `ExecStart=/usr/bin/node build`, `EnvironmentFile=/home/ecobox/.env`).

**IMPORTANT — a source change is NOT done until the service is restarted.** Editing `.svelte`/`.ts` and even running `vite build` does nothing visible: the running service keeps serving the *previous* `build/` until it restarts. After ANY source change in this repo, always run the full deploy sequence below before claiming the change works or asking the user to test. Do not skip the restart.

```bash
# 1. Build. `npm` is DISABLED on this machine; use pnpm. (pnpm 11.4+ gates native
#    build scripts behind an allow-list — see "Native build approval" below. It's
#    already approved, so `pnpm run build` works normally.)
pnpm run build
# 2. Restart the service so the new build/ is served (run as root; no sudo needed):
systemctl restart ecobox
# 3. Fix ownership — build/ and .svelte-kit/ are written as root and the service
#    runs as User=ecobox, so it can't read them until chowned back:
chown -R ecobox:ecobox build .svelte-kit
```

If you touched the bundled ELF engine (`elf/`), include it in the chown
(`chown -R ecobox:ecobox build .svelte-kit elf`). The `eci_synth` binary needs
rebuilding (`cd elf/src && make`) after a fresh checkout on a new machine, a CPU-arch
change, or any change to `eci_synth.c` / the `eci/` wrapper (e.g. the voice-parameter
flags) — not on ordinary TS source edits. The **Piper** engine is a Python virtualenv
at `piper1/venv` (the `piper-tts` package), **not** committed to git — recreate it
per machine/arch with the one-time setup in the Piper section below, and `chown -R
ecobox:ecobox piper1` after. Imported Piper voices live under `data/` (not the
bundle), so they survive deploys and are never chowned with the engine.

Type-check with `pnpm run check`.

**Verifying the live app:** the service listens on `PORT` from `.env` (currently **4923**), fronted by Caddy at `https://media.gomsen.com`. Verify with `curl localhost:4923/...`. Do NOT use `localhost:3000` — that is an unrelated `gulp serve` process, not ecobox. Confirm the restart with `systemctl is-active ecobox`.

Hot dev (`vite dev`) does not affect the running service — the service serves the last `build/` output.

### Native build approval (pnpm allow-list)

pnpm 11.4+ refuses to run dependency install/build scripts unless they're explicitly approved, and exits 1 with `ERR_PNPM_IGNORED_BUILDS` on every `pnpm install`/`pnpm run *` until each is decided. Approval lives in `pnpm-workspace.yaml` under **`allowBuilds`** (a `pkg: true|false` map — this is the key pnpm actually gates on here; a matching `onlyBuiltDependencies` list sits alongside it). The trusted, must-build deps are already set `true`:

```yaml
allowBuilds:
  better-sqlite3: true   # native SQLite binding (node-gyp)
  esbuild: true          # platform bundler binary
  msedge-tts: true       # Edge read-aloud TTS postinstall
```

If a pnpm upgrade ever rewrites those values back to the placeholder `set this to true or false` (it regenerates the block as a prompt when something is unapproved), just set them to `true` again and re-run `pnpm install`.

**better-sqlite3 binding:** `vite build` runs DB code during prerender, so it fails with "Could not locate the bindings file" if the native binding isn't compiled for the current Node version (e.g. after a Node upgrade). With the deps approved above, a plain `pnpm install` recompiles it (watch for the `gyp info ok` line). Because that install runs as root, **also `chown -R ecobox:ecobox node_modules`** afterward (alongside `build`/`.svelte-kit`) so the service can read it. Verify the binding exists with `find node_modules/.pnpm/better-sqlite3@*/ -name '*.node'`, or just hit a DB-backed endpoint (`curl -s -o /dev/null -w '%{http_code}' localhost:4923/api/settings` → 200).

### Running on Windows

Ecobox also runs natively on Windows (no WSL) — that is a supported target, not a
port-in-progress, and ELF works there too. What differs from the box above:

- **Node 22 LTS, not newer.** `better-sqlite3` 11.x has no prebuilt binary for Node 26
  and does not compile against its V8 headers (`v8::PropertyCallbackInfo::This` is
  gone), so `pnpm install` fails outright. On Node 22 it installs from a prebuild and
  needs no compiler. Bumping `better-sqlite3` would lift this — it would also have to
  be rebuilt on the Linux box.
- **`.env` is not read by the app.** systemd supplies it here via `EnvironmentFile=`;
  on Windows `start-windows.ps1` loads `.env` into the environment and then runs
  `node build`. Same rule as here: **rebuild before expecting a source change to show
  up.**
- **Relative paths are POSIX-normalized.** They are the app's public identifiers —
  URL segments and DB keys in `media_metadata`, `bookmarks`, `chaptered_*`. Windows'
  `path.join`/`path.relative` yield backslashes, which would give one file two
  identities and split its saved position across two rows. `toPosixPath()` in
  `files.ts` is applied wherever a relative path is produced (`listDirectory`,
  `getRelativePath`, `daisy.ts`'s `toRelativePath`, upload negotiate). Tests assert
  the forward-slash form rather than reproducing `path.join`'s platform behavior.
- **Piper**'s venv puts its CLI in `venv\Scripts\piper.exe`, not `venv/bin/piper`.
- `ffmpeg` and `pandoc` come from winget; both are on `PATH` like on Linux.

## Architecture

### Tech Stack
- **Framework**: SvelteKit with Node adapter (SSR)
- **Database**: SQLite via better-sqlite3, ORM via Drizzle
- **Styling**: Tailwind CSS
- **State**: Svelte 5 runes (`$state`, `$derived`, `$effect`, `$bindable`). Stores are plain TS modules (`*.svelte.ts`) that export a singleton object whose fields are runes — read them as `filesStore.sortedFiles` etc., no subscription boilerplate.

### Key Path Aliases
- `$lib` → `./src/lib`
- `$server` → `./src/server`

### Directory Structure
```
src/
├── lib/
│   ├── components/     # Svelte components
│   ├── stores/         # Rune-based stores (player, files, settings)
│   ├── services/       # Client-side services (audioEffects.ts)
│   ├── types/          # TypeScript interfaces (single index.ts)
│   └── utils/          # Utility functions (format.ts, etc.)
├── routes/
│   ├── api/            # REST endpoints: bookmarks, chaptered, download,
│   │                   #   files, files-recursive, media, protect, radio,
│   │                   #   settings, storage, upload (negotiate + stream)
│   ├── browse/[...path]/ # File browser pages
│   ├── play/[...path]/   # Media player page
│   └── settings/         # Settings page
└── server/
    ├── db/             # Drizzle schema + connection singleton
    └── services/       # files.ts, daisy.ts, id3chapters.ts, mp4chapters.ts
```

### Media Types
- **Single files**: Regular audio files (.mp3, .m4a, .m4b, etc.). Embedded chapters are extracted server-side — see "Embedded chapters" below.
- **Chaptered folders**: Directories with `.CHAPTERED` marker file — treated as a single playable unit, files become chapters in order. The marker is preserved across uploads (negotiate refuses to delete it).
- **DAISY books**: Detected by `ncc.html` / `ncc.xml` / `Navigation.xml`.
- **Radio files**: `.radio` files containing JSON `{url, name, username?, password?}`.
- **Books (TTS)**: Folders with a `.BOOK` marker, containing `book.md` + `book.chunks.json`. Created by converting an uploaded `.epub` / `.docx` / `.txt` (v1; PDF + OCR are v2). Routed to `/read/[...path]` (NOT `/play`) and read aloud via a pluggable TTS engine — the browser's Web Speech API by default, or a server-synthesized service (ElevenLabs/Azure/Google) played through an `<audio>` element. Position is a chunk (sentence) index, not seconds. See the "Book reading" section below.

### Embedded chapters
`GET /api/media/chapters?path=…` is the single source of chapters for every client (web player **and** the iOS app, which can't parse remote bytes locally — see `ios_app/AGENTS.md`). It dispatches on what the path is:

- **`.mp3`** → `$server/services/id3chapters.ts` (ID3v2.3/2.4 `CHAP` frames) → `type:'id3'`.
- **MP4 family** (`.m4b`, `.m4a`, `.mp4`, `.m4v`, `.mov`) → `$server/services/mp4chapters.ts` → `type:'mp4'`. Two layouts, tried in that order: the **QuickTime chapter track** (the audiobook standard — the audio `trak` carries `tref/chap` pointing at a text `trak` whose samples are the titles, timed by `stts`/`stsz`/`stsc`/`stco`|`co64`), then **Nero `moov/udta/chpl`**. A lone `text`-handler track with no `tref/chap` is accepted as a fallback; `sbtl`/`subp` subtitle tracks are never treated as chapters. Titles decode UTF-16 via BOM, else UTF-8. Verified against `ffprobe` across the whole library (74 files, exact match on counts, start times, and titles).
- **Folders** → DAISY (`type:'daisy'`) or plain chaptered (`type:'chaptered'`), via `getChapteredBook()` in `$server/services/daisy.ts`. See "Multi-file books" below.

Everything is read positionally through a file descriptor — `moov` usually sits behind a multi-GB `mdat`, and only the *text* track's sample table is parsed, so a 1 GB m4b answers in ~2 ms. A malformed container returns `[]` rather than throwing: missing chapters must never break playback. Adding a new container means adding a branch here — **no client change is needed**, since clients only consume `chapters` and ignore `type`.

### Multi-file books (DAISY / chaptered folders)

A chapter in a multi-file book needs **two** times, and mixing them up seeks to the wrong place:

- `startTime` — absolute on the book timeline (what "you are 3h12m into the book" means).
- `fileStartTime` — offset **within `filePath`**, i.e. what the player seeks to after loading that file.

The invariant is `startTime === file.startTime + fileStartTime`, and `files[]` (playback order, each with `duration` and `startTime`) is what lets a client place a file on the timeline without measuring audio. It matters most when several chapters share one long MP3 — routine in DAISY 2.02 — where clip times are the only thing telling them apart.

`parseVolume()` builds all of this in one pass over the SMILs: each `<par>`'s id maps to the audio clip that starts there, `ncc:totalElapsedTime` anchors each SMIL on the timeline, and clip-begin/clip-end give both file durations and the book total (cross-checked against `ncc:totalTime`). **No audio is decoded for a DAISY book** — a 52-file, 8-hour book parses in ~15 ms — and the result is cached per folder, keyed on the navigation file's size+mtime. Navigation files are decoded by their declared encoding (`<?xml encoding>` / `ncc:charset`, falling back to windows-1252 when UTF-8 yields replacement chars): DAISY 2.02 is routinely windows-1252, and reading it as UTF-8 is what turned "Capítulo" into "Cap<?>tulo".

Folders **without** navigation (plain `.CHAPTERED`) have no clip times, so durations come from `$server/services/audioDuration.ts` — `music-metadata` over a Blob (so it can seek) with a 6-wide pool, cached in `media_durations` keyed by path + size + mtime.

**`GET /api/chaptered/book?path=…`** is the one-round-trip open: chapters, `files[]`, the saved position and the bookmarks in a single response (a plain file answers `{type:'file'}`, so one request also decides *how* to open a path). `/api/media/chapters` still serves the same book data for anything that only wants chapters.

**`/api/chaptered/bookmarks`** (GET/POST/DELETE) stores bookmarks as file + offset in `chaptered_bookmarks`; a bare time would be ambiguous across 50 files. `/api/bookmarks` remains for single files.

### Book reading (TTS)
- **Conversion** (`POST /api/books/convert {path}`, `$server/services/bookConvert.ts`): pandoc converts epub/docx → GFM markdown (txt is read as-is); the markdown is stripped to plain text and sentence-split with `Intl.Segmenter` (`$lib/utils/bookChunks.ts`) into `book.chunks.json`. Requires the **`pandoc`** system binary (`apt install pandoc`); if pandoc is missing/errors, conversion **fails safe** and the original is kept. Conversion runs synchronously (v1); the `dispatchConvert` seam in the route is where v2 can wrap OCR in a background job. Triggered automatically after upload (`UploadDialog`) and via the "Convert" action in the file browser (`ActionsDropdown` → `FileExplorer.handleConvert`) for files that arrive by other means.
- **Verify gate** (`$server/services/bookVerify.ts`): the source word count is measured **independently of pandoc** (jszip for epub, mammoth for docx, the file itself for txt). On PASS (`md_words ≥ 0.90 × source_words`, non-empty, pandoc ok) the original is **deleted**; on FAIL the original is moved **inside** the book folder and the `.BOOK` marker records `verified:false`.
- **Language** is detected only for EPUB (`<dc:language>` in the OPF); docx/txt default to `'en'`. The `.BOOK` marker records `localeSource: 'detected' | 'default' | 'manual'` (older markers omit it → `'unknown'`). `book.chunks.json.locale` is the live value the reader/`/api/books/content` consume; editing the language only updates that + the marker, never re-segments (chunk indices are canonical positions).
- **Book info modal + language warning** (UI only — `BookInfoDialog`, `/api/books/info` GET/PUT, **separate from the app-facing `/content`** so existing clients are unaffected): the modal shows word/chapter/sentence counts, verified state, convert date, and an **editable language** field (PUT persists it + sets `localeSource:'manual'`). On open, when `localeSource==='default'` the reader shows a one-time "language not detected" warning; `'unknown'` stays silent.
- **Reader** (`$lib/stores/reader.svelte.ts`, `ReaderView`/`ReaderControls`/`FindInBook`): the whole chunk list loads once; play/pause/seek/find are in-memory. The reader owns position/navigation/persistence/MediaSession and delegates "make sound" to a pluggable **`TtsEngine`** (`$lib/services/tts/`): `WebSpeechEngine` (local `speechSynthesis`, units = single sentences) or `AudioEngine` (server-synthesized providers, played through a shared `<audio>` element, units = grouped sentences with prefetch). **Rate is global** (the `ttsRate` setting; the reader slider persists to it). **Web Speech voice is device-local** (`localStorage['ecobox-tts-voice']`); **audio-service voice/model are server-side** per service (`tts_credentials`). The book **content is voiced only by the engine — never put it in an `aria-live` region**; the surrounding controls/status keep normal ARIA.
- **TTS services** (`ttsService` setting): `webspeech` (default) plus server-synthesized `elevenlabs` / `azure` (key) / `azure-edge` (keyless Microsoft Edge read-aloud, experimental) / `google` / `elf` (keyless, **fully local** — see below) / `piper` (keyless, **fully local**, neural, user-imported voices — see below). Synthesis is proxied server-side (`/api/tts/synthesize`, adapters in `$server/services/tts/`) so API keys (`tts_credentials` table, sanitized by `/api/tts/config` — the key is never returned) stay off the client. Voices: `/api/tts/voices`; key check: `/api/tts/validate`. Keys can also seed from env (`ELEVENLABS_API_KEY`, `AZURE_SPEECH_KEY`/`AZURE_SPEECH_REGION`, `GOOGLE_TTS_API_KEY`). ElevenLabs is fed previous/next unit text for context and its model is selectable (default `eleven_multilingual_v2`). Its `voice_settings` (stability / similarity / style / speaker boost) are tunable in Settings and persisted on the `tts_credentials` row; they're sent from the client like `model` and folded into the audio-cache key (`unitHash`) so re-tuning re-synthesizes. `language_code` is sent only for the v2.5 models (`ELEVEN_LANG_CODE_MODELS`) — others auto-detect. **Larger units** for audio services are a runtime view (`$lib/utils/ttsUnits.ts`) over the immutable sentence chunks — `book_metadata.currentChunkIndex` stays the canonical sentence position, so switching services never breaks saved positions. On a provider error mid-read the reader falls back to Web Speech for the session.
- **ELF (local engine)** (`$server/services/tts/elf.ts`): a keyless, fully on-device service — a classic on-device ECI (6.1) voice. ecobox ships its own engine under `elf/` (vendored ECI dylibs ported to Linux ELF; see `elf/README.md`): `lib/` holds `eci.so` + per-language modules, `bin/eci_synth` is a one-shot synthesizer built from `src/` (vendored `eci/` wrapper + `eci_synth.c`, `make`). The adapter spawns `eci_synth --lib-dir … --voice-id "Reed-en-US"` per unit (text on stdin → WAV on stdout, ~10 ms), then pipes through **ffmpeg** to MP3 to match the audio/mpeg pipeline + on-disk cache. `eci_synth --list --lib-dir …` is the voice catalogue (8 presets × the languages the bundle can actually speak: en/es/fr/de/it/pt/fi, plus ja/ko/zh on Windows). Availability is decided per module by `module_available()`, which checks the module file is present — so a trimmed bundle never advertises a voice that would fail at playback (this is why zh-TW never appears: no `cht.syn` ships). **CJK is gated on POSIX only** (`lang_is_gated`): the mid-utterance crash belongs to the *converted* ja/ko/zh dylibs, not to the engine, so the Windows bundle ships the originals + their `*rom.dll` romanizers and CJK works there — verified with multi-sentence passages and repeat runs. No key/network: it's keyless like `azure-edge` (both in `TTS_KEYLESS_SERVICES`; `configured:true` always). Bundle location is `ELF_DIR` (`.env`, default `<cwd>/elf`). **Reading rate is baked into synthesis** for ELF (unlike the other audio services, which time-stretch the MP3 client-side via `<audio>.playbackRate` — that smears consonants on a formant voice). The reader's rate multiplier is passed as `eci_synth --rate M` and mapped to the engine's native `eciSpeed` (`rate_to_eci_speed`: `≈ 50 + ln(M)/0.019`, clamped 0..250 — `eciSpeed` is ~logarithmic in speed; re-calibrate the `0.019` slope if the engine/voice changes). ELF then plays at `playbackRate=1`, folds the rate into both the in-memory and on-disk (`unitHash`) cache keys, and — since rate can't be retuned live — re-speaks the current unit on a rate change (like Web Speech; gated by the engine's `liveRate` flag). **Voice parameters** (head size / pitch / inflection / roughness / breathiness / volume, each 0–100) are exposed in Settings behind a "Customize voice" toggle and passed to `eci_synth` as `--head-size`/`--pitch`/… flags, applied via `SetVoiceParam` over the chosen preset; they persist on the `tts_credentials` row (`elf_*` columns) and fold into the `unitHash` cache key when customized. **Volume is always applied and defaults to 100** (loudest) even when customization is off. **The engine's two text-"guessing" passes are forced OFF for every synthesis and intentionally NOT exposed as settings**, but via two *different* mechanisms — a known port quirk: (1) **Abbreviation expansion** is disabled by `eciSetParam(eciDictionary, 1)` in `engine_open` (`elf/src/eci/engine.c`) so "Dr."/"St."/"lbs." are read as written, not expanded (only the abbreviation dictionaries, not the main/root pronunciation ones); this `SetParam` works (default 0→1, confirmed by `GetParam`; polarity per the IBM 6.x ABI, dictionary 0=enabled/1=disabled). (2) **Phrase prediction** (guessed prosodic phrase breaks in unpunctuated text) is disabled by prepending the inline ECI directive `` `pp0 `` to the input text (`PHRASE_PREDICTION_OFF` in `elf.ts`), honored via the `eciInputType=1` backquote channel (the same path the dict rides on). **`eciSetParam(eciPhrasePrediction, 0)` is INERT in this port** — `GetParam` round-trips it but synthesis is byte-identical at 0/1 (verified by WAV diff); the `SetParam` call is kept in `engine_open` only as a belt-and-suspenders intent marker (`eciPhrasePrediction` is param 11 in `elf/src/eci/eci.h`). The upstream Eloquence driver does the same `` `pp1 ``/`` `pp0 `` text embed. **Neither setting is part of the `unitHash` cache key** (abbreviation flag is baked into the binary; the `` `pp0 `` prefix is added in `elfSynthesize` *after* the route computes the hash), so clear the TTS cache to re-synthesize already-cached ELF audio — older audio still carries phrase prediction. **Pronunciation dictionaries** (`$server/services/tts/elfDict.ts`): ELF text is rewritten by a server-side substitution pass before synthesis, sourced from `elf/lib/dictionaries/<langid>{main,root,abbr}.dic` (the eloquence_threshold-style TSV files: `key<TAB>replacement`, replacements may carry ECI backtick annotations like `` `1 `` / `` `[…] `` which the engine interprets because `eciInputType=1`). The engine's *own* `LoadDict`/`SetDict` path is **non-functional** in this port (entries silently ignored; editing a `.dic` then loading it segfaults `eci_synth`), so we substitute in text instead. The dict is keyed off the **voice's** language (parsed from voiceId, e.g. `Reed-en-US`→`enu`), **not** the book's `lang`; matching is case-sensitive whole-word; all three volumes apply (so curated user abbreviations still work even though the engine's built-in expansion is off). Substitution happens in `/api/tts/synthesize` **before** `unitHash`, so the audio cache key reflects it automatically (editing a `.dic` → different substituted text → re-synthesis; the in-memory dict is mtime-reloaded). Non-ELF services are untouched. Needs system `ffmpeg` + `libc++`/`libc++abi` (present on this host). **On Windows the same adapter drives a natively-built engine**: `elf/lib-win32/` holds the *original* 32-bit ECI runtime (`eci.dll` + the `.syn` language modules + `eci.ini`) and `elf/bin/eci_synth.exe` is committed, so a checkout needs no toolchain. `elf.ts` selects binary + module dir from `process.platform`; `dictionariesDir()` stays on `elf/lib/dictionaries`, which both builds share. One C source tree builds both, guarded by `#ifdef _WIN32` — the Windows ABI is **`__stdcall`** (the `ECI_CALL` macro in `eci/eci.h`, applied to the whole `EciApi` table *and* to `ECICallback`), the DLL doesn't export `eci{Get,Set}DefaultParam` (resolved with `LOAD_OPT`), and the POSIX drain loop is compiled out because Windows' `eciSynchronize` blocks while its `eciSpeaking` returns a truthy non-Boolean. Rebuild with `elf/src/build-win32.ps1` and an **i686** mingw-w64 gcc — the DLL is i386, so a 64-bit `eci_synth.exe` could never load it. Full rationale in `elf/README.md` § "The Windows build".
- **Piper (local engine)** (`$server/services/tts/piper.ts`): a second keyless, fully on-device service — but **neural** (VITS), not formant like ELF. The engine is **`OHF-Voice/piper1-gpl`** (the maintained successor to rhasspy/piper), installed as the **`piper-tts`** pip package into a **self-contained virtualenv at `<PIPER_DIR>/venv`** (`PIPER_DIR` default `<cwd>/piper1`). The package bundles its own `onnxruntime` and an **embedded espeak-ng phonemizer + data** — no system espeak, no vendored libs, no `LD_LIBRARY_PATH`. The venv is **machine-specific and NOT committed** (gitignored as `/piper1/`); recreate it per-machine with the one-time setup below. It ships **no voices** — the user **imports** them in Settings. Each voice is a `<stem>.onnx` model + `<stem>.onnx.json` config pair; uploads go through `POST /api/tts/piper/voices` (multipart, `config.body.maxSize` 1 GB, CSRF-guarded like any form POST) and are stored under **`PIPER_VOICES_DIR`** (`.env`, default `<dataDir>/piper-voices` — i.e. next to the db, **outside** the bundle so they survive deploys). `GET`/`DELETE` on that route list/remove imports. The adapter spawns the venv's CLI `<PIPER_DIR>/venv/bin/piper -m … -c … -f - [-s …] [--length_scale …]` per unit (single-line text on stdin → WAV on stdout via `-f -`; multi-speaker via `-s`), then pipes through **ffmpeg** to MP3 like ELF. (The old rhasspy CLI's `-q` and `--espeak_data` flags are **gone** in piper1-gpl — don't re-add them.) `piperVoices()` enumerates `data/piper-voices/*.onnx` that have a readable `.onnx.json` (one voice per single-speaker model, one per speaker for multi-speaker → id `"<stem>"` or `"<stem>#<id>"`); `lang` comes from the config's `language.code` (`en_US`→`en-US`). **Like ELF, the reading rate is baked into synthesis** — passed as `--length_scale` (a duration multiplier = `baseLengthScale / rate`, where `baseLengthScale` is the voice config's own `inference.length_scale`), so Piper re-paces the waveform natively instead of time-stretching the MP3 (higher fidelity; stretching is reserved for the cloud services, where re-synth would re-bill/add latency). Consequently `liveRate=false`, rate **is** in the cache key, and the reader re-speaks the current unit on a rate change. The ELF-vs-stretch split is no longer hard-coded to `'elf'`: it's the shared **`TTS_BAKED_RATE_SERVICES` / `bakesRate()`** predicate (`['elf','piper']`) used by `AudioEngine` (`liveRate`, `playbackRate`, in-memory cache key) and the synthesize route (on-disk `unitHash` rate fold). No voice-param knobs and **no new DB columns** — voice selection reuses `tts_credentials.voiceId`. **`/api/tts/voices` does NOT cache `piper`** (its list is mutable at runtime; other services keep the 5-min cache). Needs system `ffmpeg` (plus Python ≥3.9; the box has 3.12 + `python3.12-venv`). **Why the venv (engine upgrade, 2026-06):** we used to vendor the prebuilt rhasspy/piper **1.2.0** C++ binary under `piper/`, but it **aborts** on voices built with Piper ≥1.3 — `terminate … "Phonemes must be one codepoint (phoneme id map)"` — because newer voices encode multi-codepoint phonemes (e.g. diphthongs `aɪ aʊ ɔɪ eɪ oʊ`). The `phoneme_id_map` keys are single-codepoint in 1.2-era voices and the binary asserts that. piper1-gpl removed the assertion and runs **both** old and new voices, but ships **only as a Python package** (no standalone C++ binary), hence the venv. A voice's target version is stamped as `piper_version` in its `.onnx.json`. One-time venv setup (per machine / CPU arch — the venv has absolute paths baked in, so it isn't portable and isn't in git):

```bash
cd /home/ecobox
apt-get install -y python3.12-venv          # provides ensurepip (once per box)
python3 -m venv piper1/venv
piper1/venv/bin/python -m pip install -U pip
piper1/venv/bin/python -m pip install piper-tts   # pulls onnxruntime + embedded espeak-ng
chown -R ecobox:ecobox piper1               # the service runs as User=ecobox
systemctl restart ecobox
# verify: piper1/venv/bin/python -m pip show piper-tts   and the Settings → Piper "Test" button
#   (the piper1-gpl CLI has no --version flag; `-m/--model` is required)
# imported voices live in data/piper-voices/ (gitignored) and are untouched by this
# the old C++ bundle in piper/ is dead — safe to `git rm -r piper/`
```
- **Audio cache**: synthesized MP3 is cached on disk under `data/tts-cache/` (override `TTS_CACHE_DIR`), mirroring the media tree (`<cacheRoot>/<bookPath>/<unitHash>.mp3`) so re-reads are free. Cleared automatically when a book (or a parent folder of books) is deleted — the DELETE handler calls `purgeCacheForPath` and the mirrored subtree goes with it. Size readout + manual clear live in Settings (`/api/tts/cache` GET/DELETE).
- **Background / lock-screen playback** now works for the audio services (real `<audio>` element + MediaSession). Web Speech still can't background reliably (engine limitation, worst on iOS); its caveats: pause = `cancel()` + remembered index (engine `pause()` is unreliable); changing rate/voice mid-utterance re-speaks the current sentence (the API can't retune a live utterance — audio services retune live via `playbackRate`). Chrome's ~15s long-utterance cutoff is mitigated by sentence-sized chunks; the optional `pause()/resume()` keepalive pump was **removed** (re-add only if the cutoff actually shows up — see the `tts-keepalive-pump` auto-memory).
- npm deps: `jszip`, `mammoth`, `msedge-tts` (all pure-JS, no native build).

### Player keyboard shortcuts & track navigation
Both players share a code-based `handleKeydown` (media: `PlaybackView.svelte`; reader: `ReaderView.svelte`) that bails on input/textarea focus and open modals. Two opt-in settings gate the new behavior (both default **false**, persisted like any setting — `winampShortcuts`, `autoAdvanceTracks`):

- **`winampShortcuts`** — Winamp-style bare-key transport, active in the media player **and** the book reader. Handled in a dedicated block placed *before* the default `switch` (so it can override a default binding — e.g. media `b` is normally "add bookmark"), gated on the setting **and no modifier keys** (so Ctrl/Cmd combos and typing stay untouched):
  - `x` = play — idempotent, **never pauses** if already playing (`if (!isPlaying) play()`).
  - `c` = play/pause toggle.
  - `v` = "stop" = `pause()` — keeps position, deliberately does **not** seek to 0.
  - `b` = next track, `z` = previous track.
- **`autoAdvanceTracks`** — when a single (non-chaptered, non-radio) file ends, play the next file in the **same folder**. Chaptered folders already auto-advance internally (`player.svelte.ts` `handleEnded`), so this only affects single files.

**Next/previous track (media player)** lives in `PlaybackView.switchTrack(±1)`: it lists the current file's folder siblings via `/api/files` (audio-only, natural sort), finds the current file, and `goto()`s the neighbour. It **never crosses folder boundaries and never wraps** past the first/last file (no-op at the edge). Chaptered folders instead map `b`/`z` to `nextChapter`/`previousChapter` (stays within the folder unit); radio is a no-op. Auto-advance reuses this same helper via the store's **`onTrackEnded`** callback — the store owns "a track ended", the view owns routing + sibling listing. To keep playing across the switch regardless of the `autoplay` setting, set **`playerStore.playOnNextLoad = true`** before navigating (`loadFile` consumes it, one-shot). The play route (`/play/[...path]/+page.svelte`) wraps `<PlaybackView>` in `{#key filePath}` so a track switch fully remounts (onMount reloads + plays the new file).

**Next/previous track (book reader)** — `b`/`z` navigate **by chapter**: `ReaderView.nextTrack()`/`prevTrack()` delegate to the reader store's `nextHeading()`/`prevHeading()` (chapters == heading chunks), which resume reading if we were already playing (mirrors the media player). The reader's `x`/`c`/`v` are fully functional too.

**Chapter navigation (media player)** — the Chapters button sits beside the bookmark ("markers") buttons in the footer and appears whenever `playerStore.chapters.length > 0` (embedded chapters, DAISY, or a chaptered folder alike). `ChapterList` mirrors `BookmarkList`'s listbox pattern: roving tabindex, Up/Down/Home/End, Enter/Space to jump, Escape to close, focus opening on the *playing* chapter and returning to the button on close (`aria-selected` marks the current chapter, not merely the focused row). Shortcut: **`c`** opens the list. With `winampShortcuts` on, bare `c` is play/pause and is claimed by the Winamp block first — **`Shift+C`** always reaches the chapter list, so it stays keyboard-reachable either way.

**Chapter as a seek unit** — when the media has chapters, the seek-unit radio group gains a **"Chapter"** option after the time units (index `CHAPTER_UNIT_INDEX === SEEK_UNITS.length`; `seekUnitIndex` persists to `localStorage['ecobox-seek-unit-index']` as before). With it selected, `ArrowLeft`/`ArrowRight` and the inner transport buttons call `previousChapter()`/`nextChapter()` instead of `seekRelative(±seconds)` — `PlaybackControls` takes optional `seekLabel`/`seekBackAria`/`seekForwardAria` overrides for the non-numeric badge. Selection degrades safely: `isChapterSeek` requires chapters to actually exist, so a file without them falls back to time seeking (a saved chapter index doesn't strand the arrows).

### Path safety
All filesystem-touching API routes go through `resolvePath()` in `$server/services/files.ts`, which joins against `MEDIA_ROOT` and rejects traversal. New endpoints that take a user-supplied path **must** go through it; throw the resulting error as a 403 if the message contains `traversal` (see existing handlers for the pattern). The file service follows symlinks intentionally — `MEDIA_ROOT` may be a symlink tree.

### Upload negotiation contract
`POST /api/upload/negotiate` is the planning step before any byte transfer. It accepts `{ basePath, mode: 'copy' | 'sync', files: [{path, size}] }` and returns:

- `newFiles` — not present in destination
- `conflicts` — present with a different size
- `identical` — present with the same size (skipped)
- `extras` — in destination but not in upload set
- `toUpload` — what the client should actually POST to `/api/upload/stream` (in `copy` mode this excludes conflicts; in `sync` mode it includes them)
- `toDelete` — only in `sync` mode; full paths the client should DELETE before uploading

The four breakdown fields are mode-independent and are what the upload dialog uses to render its conflict preview. Don't bypass negotiate from the client — the server is also where `.CHAPTERED` deletion is filtered out.

### Database Schema
- `media_metadata` — playback position, duration, favorites
- `bookmarks` — time-stamped bookmarks for single files
- `chaptered_metadata` — playback state for multi-file chaptered content
- `chaptered_bookmarks` — bookmarks within chaptered folders (file + offset in that file)
- `media_durations` — cached audio durations, invalidated by size + mtime (never user data; safe to delete)
- `settings` — key-value settings storage
- `book_metadata` — reading position (current chunk index) for converted books

### Environment Variables
```
MEDIA_ROOT=/path/to/media       # Root directory for media files
DATABASE_URL=file:./data/ecobox.db
PORT=3000
ORIGIN=https://your-domain.com  # For production CORS
```

## Accessibility expectations

Accessibility is a first-class requirement, not an afterthought — many of this app's users rely on keyboard-only navigation and screen readers. When adding or modifying UI:

- Every interactive element needs a clear `aria-label` (or visible label) and reachable focus.
- Use real ARIA patterns for menus / dialogs / tabs / progress (`role="menu"` + `aria-haspopup` + arrow-key nav, `role="dialog"` + `aria-modal` + Escape, `role="progressbar"` with `aria-valuenow`).
- Long-running or async state changes should announce through `aria-live` regions (see `UploadDialog`, `FileExplorer` `atRootAnnouncement`).
- Manage focus deliberately: focus the first item when a dialog opens, restore focus on close, and don't trap users in elements they can't escape with `Esc` / `Tab`.
- Global keyboard shortcuts (e.g. **Alt+N** for the actions menu, **Backspace** for parent dir) must be ignored when focus is in an input/textarea/contenteditable, and when a modal is open.

## Testing

Unit tests are co-located with source files using `.test.ts` suffix. Run specific tests with `npx vitest <path>`.
