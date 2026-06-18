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

If you touched the bundled ELF engine (`elf/`), include it in the
chown (`chown -R ecobox:ecobox build .svelte-kit elf`). The `eci_synth`
binary needs rebuilding (`cd elf/src && make`) after a fresh checkout on a new
machine, a CPU-arch change, or any change to `eci_synth.c` / the `eci/` wrapper
(e.g. the voice-parameter flags) — not on ordinary TS source edits.

Type-check with `pnpm run check`.

**Verifying the live app:** the service listens on `PORT` from `.env` (currently **4923**), fronted by Caddy at `https://ecobox.oriolgomez.com`. Verify with `curl localhost:4923/...`. Do NOT use `localhost:3000` — that is an unrelated `gulp serve` process, not ecobox. Confirm the restart with `systemctl is-active ecobox`.

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
    └── services/       # files.ts, daisy.ts, id3chapters.ts
```

### Media Types
- **Single files**: Regular audio files (.mp3, .m4a, .m4b, etc.)
- **Chaptered folders**: Directories with `.CHAPTERED` marker file — treated as a single playable unit, files become chapters in order. The marker is preserved across uploads (negotiate refuses to delete it).
- **DAISY books**: Detected by `ncc.html` / `ncc.xml` / `Navigation.xml`.
- **Radio files**: `.radio` files containing JSON `{url, name, username?, password?}`.
- **Books (TTS)**: Folders with a `.BOOK` marker, containing `book.md` + `book.chunks.json`. Created by converting an uploaded `.epub` / `.docx` / `.txt` (v1; PDF + OCR are v2). Routed to `/read/[...path]` (NOT `/play`) and read aloud via a pluggable TTS engine — the browser's Web Speech API by default, or a server-synthesized service (ElevenLabs/Azure/Google) played through an `<audio>` element. Position is a chunk (sentence) index, not seconds. See the "Book reading" section below.

### Book reading (TTS)
- **Conversion** (`POST /api/books/convert {path}`, `$server/services/bookConvert.ts`): pandoc converts epub/docx → GFM markdown (txt is read as-is); the markdown is stripped to plain text and sentence-split with `Intl.Segmenter` (`$lib/utils/bookChunks.ts`) into `book.chunks.json`. Requires the **`pandoc`** system binary (`apt install pandoc`); if pandoc is missing/errors, conversion **fails safe** and the original is kept. Conversion runs synchronously (v1); the `dispatchConvert` seam in the route is where v2 can wrap OCR in a background job. Triggered automatically after upload (`UploadDialog`) and via the "Convert" action in the file browser (`ActionsDropdown` → `FileExplorer.handleConvert`) for files that arrive by other means.
- **Verify gate** (`$server/services/bookVerify.ts`): the source word count is measured **independently of pandoc** (jszip for epub, mammoth for docx, the file itself for txt). On PASS (`md_words ≥ 0.90 × source_words`, non-empty, pandoc ok) the original is **deleted**; on FAIL the original is moved **inside** the book folder and the `.BOOK` marker records `verified:false`.
- **Language** is detected only for EPUB (`<dc:language>` in the OPF); docx/txt default to `'en'`. The `.BOOK` marker records `localeSource: 'detected' | 'default' | 'manual'` (older markers omit it → `'unknown'`). `book.chunks.json.locale` is the live value the reader/`/api/books/content` consume; editing the language only updates that + the marker, never re-segments (chunk indices are canonical positions).
- **Book info modal + language warning** (UI only — `BookInfoDialog`, `/api/books/info` GET/PUT, **separate from the app-facing `/content`** so existing clients are unaffected): the modal shows word/chapter/sentence counts, verified state, convert date, and an **editable language** field (PUT persists it + sets `localeSource:'manual'`). On open, when `localeSource==='default'` the reader shows a one-time "language not detected" warning; `'unknown'` stays silent.
- **Reader** (`$lib/stores/reader.svelte.ts`, `ReaderView`/`ReaderControls`/`FindInBook`): the whole chunk list loads once; play/pause/seek/find are in-memory. The reader owns position/navigation/persistence/MediaSession and delegates "make sound" to a pluggable **`TtsEngine`** (`$lib/services/tts/`): `WebSpeechEngine` (local `speechSynthesis`, units = single sentences) or `AudioEngine` (server-synthesized providers, played through a shared `<audio>` element, units = grouped sentences with prefetch). **Rate is global** (the `ttsRate` setting; the reader slider persists to it). **Web Speech voice is device-local** (`localStorage['ecobox-tts-voice']`); **audio-service voice/model are server-side** per service (`tts_credentials`). The book **content is voiced only by the engine — never put it in an `aria-live` region**; the surrounding controls/status keep normal ARIA.
- **TTS services** (`ttsService` setting): `webspeech` (default) plus server-synthesized `elevenlabs` / `azure` (key) / `azure-edge` (keyless Microsoft Edge read-aloud, experimental) / `google` / `elf` (keyless, **fully local** — see below). Synthesis is proxied server-side (`/api/tts/synthesize`, adapters in `$server/services/tts/`) so API keys (`tts_credentials` table, sanitized by `/api/tts/config` — the key is never returned) stay off the client. Voices: `/api/tts/voices`; key check: `/api/tts/validate`. Keys can also seed from env (`ELEVENLABS_API_KEY`, `AZURE_SPEECH_KEY`/`AZURE_SPEECH_REGION`, `GOOGLE_TTS_API_KEY`). ElevenLabs is fed previous/next unit text for context and its model is selectable (default `eleven_multilingual_v2`). Its `voice_settings` (stability / similarity / style / speaker boost) are tunable in Settings and persisted on the `tts_credentials` row; they're sent from the client like `model` and folded into the audio-cache key (`unitHash`) so re-tuning re-synthesizes. `language_code` is sent only for the v2.5 models (`ELEVEN_LANG_CODE_MODELS`) — others auto-detect. **Larger units** for audio services are a runtime view (`$lib/utils/ttsUnits.ts`) over the immutable sentence chunks — `book_metadata.currentChunkIndex` stays the canonical sentence position, so switching services never breaks saved positions. On a provider error mid-read the reader falls back to Web Speech for the session.
- **ELF (local engine)** (`$server/services/tts/elf.ts`): a keyless, fully on-device service — a classic on-device ECI (6.1) voice. ecobox ships its own engine under `elf/` (vendored ECI dylibs ported to Linux ELF; see `elf/README.md`): `lib/` holds `eci.so` + per-language modules, `bin/eci_synth` is a one-shot synthesizer built from `src/` (vendored `eci/` wrapper + `eci_synth.c`, `make`). The adapter spawns `eci_synth --lib-dir … --voice-id "Reed-en-US"` per unit (text on stdin → WAV on stdout, ~10 ms), then pipes through **ffmpeg** to MP3 to match the audio/mpeg pipeline + on-disk cache. `eci_synth --list` is the voice catalogue (8 presets × the working languages: en/es/fr/de/it/pt/fi). **CJK is gated out** (converted ja/ko/zh modules crash mid-utterance). No key/network: it's keyless like `azure-edge` (both in `TTS_KEYLESS_SERVICES`; `configured:true` always). Bundle location is `ELF_DIR` (`.env`, default `<cwd>/elf`). **Reading rate is baked into synthesis** for ELF (unlike the other audio services, which time-stretch the MP3 client-side via `<audio>.playbackRate` — that smears consonants on a formant voice). The reader's rate multiplier is passed as `eci_synth --rate M` and mapped to the engine's native `eciSpeed` (`rate_to_eci_speed`: `≈ 50 + ln(M)/0.019`, clamped 0..250 — `eciSpeed` is ~logarithmic in speed; re-calibrate the `0.019` slope if the engine/voice changes). ELF then plays at `playbackRate=1`, folds the rate into both the in-memory and on-disk (`unitHash`) cache keys, and — since rate can't be retuned live — re-speaks the current unit on a rate change (like Web Speech; gated by the engine's `liveRate` flag). **Voice parameters** (head size / pitch / inflection / roughness / breathiness / volume, each 0–100) are exposed in Settings behind a "Customize voice" toggle and passed to `eci_synth` as `--head-size`/`--pitch`/… flags, applied via `SetVoiceParam` over the chosen preset; they persist on the `tts_credentials` row (`elf_*` columns) and fold into the `unitHash` cache key when customized. **Volume is always applied and defaults to 100** (loudest) even when customization is off. **The engine's two text-"guessing" passes are forced OFF for every synthesis and intentionally NOT exposed as settings** (`engine_open` in `elf/src/eci/engine.c`): `eciSetParam(eciDictionary, 1)` disables abbreviation expansion (so "Dr."/"St."/"lbs." are read as written, not expanded — only the abbreviation dictionaries, not the main/root pronunciation ones) and `eciSetParam(eciPhrasePrediction, 0)` disables phrase prediction. Polarity per the IBM 6.x ABI (dictionary 0=enabled/1=disabled; phrase prediction 0=off) — `eciPhrasePrediction` is param 11, added to `elf/src/eci/eci.h`. These are baked into the binary, so they're NOT part of the `unitHash` cache key; clear the TTS cache to re-synthesize already-cached ELF audio. Needs system `ffmpeg` + `libc++`/`libc++abi` (present on this host).
- **Audio cache**: synthesized MP3 is cached on disk under `data/tts-cache/` (override `TTS_CACHE_DIR`), mirroring the media tree (`<cacheRoot>/<bookPath>/<unitHash>.mp3`) so re-reads are free. Cleared automatically when a book (or a parent folder of books) is deleted — the DELETE handler calls `purgeCacheForPath` and the mirrored subtree goes with it. Size readout + manual clear live in Settings (`/api/tts/cache` GET/DELETE).
- **Background / lock-screen playback** now works for the audio services (real `<audio>` element + MediaSession). Web Speech still can't background reliably (engine limitation, worst on iOS); its caveats: pause = `cancel()` + remembered index (engine `pause()` is unreliable); changing rate/voice mid-utterance re-speaks the current sentence (the API can't retune a live utterance — audio services retune live via `playbackRate`). Chrome's ~15s long-utterance cutoff is mitigated by sentence-sized chunks; the optional `pause()/resume()` keepalive pump was **removed** (re-add only if the cutoff actually shows up — see the `tts-keepalive-pump` auto-memory).
- npm deps: `jszip`, `mammoth`, `msedge-tts` (all pure-JS, no native build).

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
- `chaptered_bookmarks` — bookmarks within chaptered folders
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
