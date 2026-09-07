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

### Media storage (Storage Box over sshfs)

`MEDIA_ROOT` is **not local disk**: it is a Hetzner Storage Box mounted over sshfs at
`/mnt/storagebox` (systemd `mnt-storagebox.mount` + `.automount`, outside this repo).
The link is fast but **far** — ~83 ms RTT — so bandwidth is never the bottleneck and
round trips always are. Measured 2026-08-26:

| operation | cost |
|---|---|
| bulk read / write | ~18 MB/s each way — matches raw `scp`, i.e. at line rate |
| `stat`, warm | ~1 ms (60 s `attr_timeout`/`entry_timeout`, so listings are fine) |
| **file creation** | **~480 ms** (~6 round trips), *regardless of file size* |
| `rm` | ~160 ms |

Two consequences, both easy to misdiagnose as "the app is slow":

- **Creates serialize per directory.** Writing into one folder is capped at ~2.5 files/s
  at *any* concurrency (the kernel holds the directory inode lock), versus 16.5 files/s
  spread across 8 folders. A many-small-file upload therefore **cannot** be sped up by
  uploading more files in parallel — the fix is staging on local disk (`/home/ecobox` is
  local) and moving them across afterwards. Large single files are already at line rate.
- **Positional reads cost a full RTT each.** The "~2 ms for a 1 GB m4b" figure under
  "Embedded chapters" is a local-disk number; `mp4chapters.ts` does small random reads,
  so against the Storage Box each one is ~83 ms.

**FUSE readahead is tuned outside this repo, and reads collapse without it.** The bdi
default `read_ahead_kb=128` caps sequential reads at ~2.8 MB/s (the bandwidth-delay
product here is ~1.5 MB, so 128 KB is ~12x too small); at 4096 it does 12–23 MB/s.
`/usr/local/sbin/fuse-tune` + `storagebox-tune.service` (oneshot, `PartOf=` /
`WantedBy=mnt-storagebox.mount`) reapply it on every mount. It has to be a service that
resolves the bdi at runtime from `/proc/self/mountinfo`, because sshfs has no readahead
option (`max_read` is the SFTP request size, not the readahead window), mount units
reject `ExecStartPost=`, and the bdi carries no identifying udev attributes while its
number is reallocated on every remount. If reads ever feel slow again, check
`read_ahead_kb` is not back at 128:

```bash
cat /sys/class/bdi/$(grep ' /mnt/storagebox ' /proc/self/mountinfo \
  | grep fuse | awk '{print $3}')/read_ahead_kb    # want 4096, not 128
```

### Native build approval (pnpm allow-list)

pnpm 11.4+ refuses to run dependency install/build scripts unless they're explicitly approved, and exits 1 with `ERR_PNPM_IGNORED_BUILDS` on every `pnpm install`/`pnpm run *` until each is decided. Approval lives in `pnpm-workspace.yaml` under **`allowBuilds`** (a `pkg: true|false` map — this is the key pnpm actually gates on here; a matching `onlyBuiltDependencies` list sits alongside it). The trusted, must-build deps are already set `true`:

```yaml
allowBuilds:
  better-sqlite3: true   # native SQLite binding (node-gyp)
  esbuild: true          # platform bundler binary
  msedge-tts: true       # Edge read-aloud TTS postinstall
```

If a pnpm upgrade ever rewrites those values back to the placeholder `set this to true or false` (it regenerates the block as a prompt when something is unapproved), just set them to `true` again and re-run `pnpm install`.

**better-sqlite3 binding:** `vite build` runs DB code during prerender, so it fails with "Could not locate the bindings file" if the native binding isn't compiled for the current Node version (e.g. after a Node upgrade). With the deps approved above, a plain `pnpm install` recompiles it (watch for the `gyp info ok` line). Because that install runs as root, **also `chown -R ecobox:ecobox node_modules`** afterward (alongside `build`/`.svelte-kit`) so the service can read it. Verify the binding exists with `find node_modules/.pnpm/better-sqlite3@*/ -name '*.node'`, or just hit a DB-backed endpoint (`curl -s -o /dev/null -w '%{http_code}' localhost:4923/api/settings` → 200, or **401** once the app's login is enabled — either answer proves the service booted, which it cannot do with a broken binding).

### Running on Windows

Ecobox also runs natively on Windows (no WSL) — that is a supported target, not a
port-in-progress, and ELF works there too. What differs from the box above:

- **Node 20 – 26** (`better-sqlite3` 12.x `engines`), with a prebuilt binary for each,
  so no compiler is needed. This is why the dependency was bumped from 11.x: that
  version reached its ceiling at Node 24 and failed to compile against Node 26's V8
  headers (`v8::PropertyCallbackInfo::This` is gone).
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
│   ├── api/            # REST endpoints: bookmarks, chaptered, describe, download,
│   │                   #   ensure-playable, files, files-recursive, media, protect,
│   │                   #   radio, recent, settings, storage, upload (negotiate + stream)
│   ├── browse/[...path]/ # File browser pages
│   ├── play/[...path]/   # Media player page
│   └── settings/         # Settings page
└── server/
    ├── db/             # Drizzle schema + connection singleton
    └── services/       # files.ts, daisy.ts, id3chapters.ts, mp4chapters.ts,
                        #   subtitles.ts, videoConvert.ts, videoDescribe.ts
```

### Media Types
- **Single files**: Regular audio files (.mp3, .m4a, .m4b, etc.). Embedded chapters are extracted server-side — see "Embedded chapters" below.
- **Video files**: Played, never shown — see "Video (audio-only playback)" below.
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

### Video (audio-only playback)

Video is a playable media type, but the picture is never rendered: a video file is
loaded into the **same `<audio>` element** as everything else, which decodes the
audio track and has nowhere to draw the video. There is no `<video>` tag anywhere in
the app and no per-file "video mode" — a row routes to `/play` exactly like an mp3.

`$lib/utils/mediaTypes.ts` is the one place extensions are classified (pure, no
server imports, so `files.ts`, `daisy.ts`, `PlaybackView` and `UploadDialog` all
agree). It splits video in two, and the split is the whole design:

- **`PLAYABLE_VIDEO_EXTENSIONS`** (`.mp4 .m4v .mov .webm`) — the browser can demux
  these, so they stream as-is with their real `Content-Type` (`/api/media/[...path]`
  carries the video MIME table). `isPlayableMedia()` counts them, so they take part
  in next/previous track and in `.CHAPTERED` folders.
- **`CONVERTIBLE_VIDEO_EXTENSIONS`** (`.mkv .avi .wmv .ts .mpg .vob .ogv …`) — no
  browser opens these, so their audio is **auto-extracted after upload**
  (`needsAudioExtraction()`), the same way an uploaded `.epub` is auto-converted.
  Otherwise they would sit in the library as permanently unplayable rows.

**The extension is only half the answer, and assuming otherwise was a real bug.**
A demuxable container still has to carry a codec the browser can *decode*: a TV rip
muxed as `.mp4` with an **E-AC-3** (Dolby Digital Plus) track opens perfectly and
then plays **silence** — no error, no event, just nothing, which reads as "the app
is broken". `BROWSER_AUDIO_CODECS` in `mediaTypes.ts` is the short list that
actually decodes everywhere (`aac mp3 opus vorbis flac`); `ac3`/`eac3`/`dts`/
`truehd`/`wmav2` are licensed codecs no desktop browser ships, and `alac` is
Safari-only. The list is deliberately conservative because the two ways of being
wrong are not symmetric: a false "playable" costs the user silence, a false
"unplayable" costs one re-encode.

**`POST /api/media/ensure-playable {path}`** is the automatic post-upload check —
`UploadDialog` calls it for **every** uploaded video, and `ensureVideoPlayable()`
does the least destructive thing that works:

| what's wrong | what happens |
|---|---|
| container no browser demuxes (`.mkv`…) | `extractVideoAudio()` — sibling audio file, video deleted (unchanged) |
| container fine, audio codec undecodable | **`reencodeVideoAudio()` — audio rewritten in place, picture kept** |
| nothing | `{action:'skipped'}`, the common case; announces nothing |

`reencodeVideoAudio()` **stream-copies the video** (`-c:v copy`) and re-encodes only
the audio to AAC 128k, downmixed to stereo above 2 channels, text subtitles carried
across as `mov_text`, `+faststart`. Two things about it matter:

- **The picture is kept on purpose.** Throwing it away to fix an audio codec would
  be an overreaction — the picture is exactly what "describe what's on screen"
  reads, so extracting the audio would silently kill that feature for the file.
- **The output keeps the source's name**, so `media_metadata`, `bookmarks` and
  `recent_files` — all keyed by relative path — stay valid. It writes to a hidden
  sibling (`.<base>.ecobox-reencode<ext>`; listings skip dotfiles, so a half-written
  file is never a row) and `rename`s over the original **only after verifying** the
  result: non-empty, audio codec now playable, video stream still present, duration
  within 2% (2s floor). Any failure deletes the temp and leaves the original alone.
- Only the **MP4 family** can be repaired this way (`REENCODABLE_VIDEO_EXTENSIONS` =
  `.mp4 .m4v .mov`) — AAC has nowhere to live in a WebM, so a WebM with an odd codec
  falls back to extraction.

The manual ⋮ **"Extract audio"** action (`/api/media/extract-audio`) is unchanged and
still means what it says: *give me an audio file and take the video away*. That is a
different intent from "make this play", which is why it is a different route.

**`POST /api/media/extract-audio {path}`** → `$server/services/videoConvert.ts`. It
is offered by hand for *any* video (the ⋮ menu's "Extract audio", which shares
`onconvert` with the book "Convert" action — `FileExplorer.handleConvert` branches on
`file.isVideoFile`), since streaming 4 GB to hear 100 MB is wasteful even when it
works. The pipeline mirrors `bookConvert`, deliberately: **probe → extract → verify
independently → only then delete the original**. Nothing is deleted on any failure.

- **Audio is stream-copied whenever it can be** (`chooseAudioTarget`, unit-tested):
  aac/alac→`.m4a`, mp3→`.mp3`, flac→`.flac`, opus→`.opus`, vorbis→`.ogg`. That turns a
  4 GB mkv into its audio track in well under a second and loses nothing. Anything
  else (AC-3, DTS, TrueHD, PCM, WMA) is transcoded to AAC 128k, downmixed to stereo
  above 2 channels. `.m4a` output always gets **`-movflags +faststart`** — without it
  the `moov` index lands at the end and a browser must fetch the whole file to seek.
- **The output keeps the source's base name** (`movie.mkv` → `movie.m4a`), which is
  what keeps sidecar subtitles matching; only a real collision gets a ` (audio N)`
  suffix.
- **Verify** is a re-probe of the *produced* file: non-empty, and its duration within
  2% (2s floor) of the source's. A short or empty result is deleted and the video
  kept — a truncated extraction must never cost the user their only copy.
- **Text subtitle streams are pulled out as sidecars** while the container is open
  (`subrip`/`ass`/`mov_text`/`webvtt` → `<base>.<lang>.srt`, e.g. `movie.eng.srt`),
  which the prefix matcher below then picks up automatically. Image-based tracks
  (PGS, VobSub) are skipped: they would need OCR. An existing file is never
  overwritten, and a subtitle that fails to extract is a missing extra, not a failed
  conversion.

Needs system **`ffmpeg`** + **`ffprobe`** (both already on this host, and on Windows
via winget). Conversion runs synchronously (v1); the route's `dispatchExtract` seam
is where a long transcode can later become a background job.

### Video description ("what is on screen?")

The one thing audio-only playback can never give a blind listener is the picture.
**`POST /api/describe {path, start, end, language?}`** closes that gap: the user
marks a segment in the player, ffmpeg cuts that span out as a real clip, and a
model watches it.

**Why Gemini and not Claude.** The Claude API takes images only — there is no
`video` content block, and a `video/mp4` is refused by both the image block
("Supported image formats are JPEG, PNG, GIF, and WebP") and the document block
("Only PDF and plaintext documents are supported"). Frames sampled from a segment
lose exactly what a blind listener most needs — motion, direction, who moved where
— so the engine is `generativelanguage.googleapis.com` (`@google/genai`), which
ingests video. Model is **`gemini-3.8-flash`**, overridable with
`GEMINI_DESCRIBE_MODEL` because model names churn faster than this file does; a
wrong name surfaces as the `badModel` code (a 404), not a mystery failure.

- **Marks, then describe.** In `PlaybackView`, **`d`** marks the start, **`Shift+D`**
  the end, **`Ctrl/Cmd+Shift+D`** asks — and the same three actions are footer
  buttons ("Mark start" / "Mark end" / "Describe"), since a shortcut nobody can find
  is not a feature. Bare `Ctrl+D` is deliberately **not** claimed (it stays the
  browser's bookmark shortcut). The keys are live only for videos
  (`isVideoExtension`), which includes containers the browser can't play: ffmpeg
  reads an `.mkv` the `<audio>` element refuses. State lives in
  `$lib/stores/videoDescribe.svelte.ts` and is **keyed to one file** — moving to the
  next track or the next file of a chaptered folder drops the marks, because a mark
  at 3:20 means nothing in the next episode.
- **The clip.** One ffmpeg pass, `-ss` *before* `-i` (seek, don't decode from the
  top of a 4 GB film) with `-t` bounding the work. The video is **re-encoded, not
  stream-copied**: a copy can only cut on a keyframe, which drifts the marks by
  seconds. 720p max (`scale='min(720,iw)':-2`) keeps on-screen text legible, and
  crf 30 / veryfast keeps it small — a 10-second clip measures ~97 KB, so even a
  300-second one (`MAX_DESCRIBE_SECONDS`) stays a few MB. The clip is written to a
  **temp dir on local disk** (`os.tmpdir()`), never into MEDIA_ROOT — a file create
  on the sshfs mount costs ~0.5 s — and is deleted in a `finally`.
- **Audio rides along, and that is the point.** `-map 0:a:0?` (optional, so silent
  videos still work) means the model *hears* the segment. "Never restate what the
  listener can already hear" stops being a hope and becomes something it can check,
  and it covers what subtitles never carry — a scream, a car, a song. This replaced
  an earlier hack that fed the sidecar `.srt` in as text; `hasAudio` is reported back
  and switches that rule in the system prompt.
- **Sampling and resolution.** `videoMetadata.fps` from `planVideoFps()` (pure,
  unit-tested): 2 fps up to 20 s, then 1, 0.5, 0.25 — a short mark is a specific
  action and wants detail, a long one is a scene summary. `mediaResolution` is
  **HIGH**: reading a street sign or a phone screen is the whole point of some
  descriptions and does not survive downscaling. `thinkingLevel: LOW` — seeing is
  perception, not deliberation, and someone is waiting.
- **Inline vs upload.** Clips ≤ 12 MB go inline as base64 (one round trip); larger
  ones go through `ai.files.upload`, poll until `ACTIVE`, and are **deleted after
  the call** so they don't linger 48 h on the user's account. In practice the size
  bound above means inline nearly always wins.
- **The prompt is half the feature.** Describe only what can be SEEN; never restate
  speech or sound; **read out on-screen text verbatim** (signs, captions, credits —
  the information they cannot get any other way); lead with what CHANGES across the
  segment. `language` (the UI locale) is mapped to a language name so the
  description comes back in the user's own language.
- **The key never reaches the browser.** `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) in
  `.env`, or a key the user saves in `DescribeKeyDialog` (stored in the
  **`ai_credentials`** table under provider `google`, which wins over the env).
  **`/api/describe/key`** is write-only: `GET` answers `{configured, source}` and
  never the key, `PUT` validates the `AIza…` shape before storing, `DELETE` falls
  back to the env key. The dialog opens by itself the first time a description is
  asked for with no key, and again on `badKey`, focusing the field.
- **Every failure is a code, not a sentence.** `DescribeResult` is
  `{ok:true,…} | {ok:false, code, detail?}` over ~20 `DescribeErrorCode`s, each with
  a `describe.error*` translation in all seven locales — so the reason reaches a
  screen reader in the user's language. Two mappings are worth knowing: a bad key
  arrives as **HTTP 400** `API_KEY_INVALID` (not 401), and **429 covers two
  different situations** — a rate limit you wait out, and an account with no credit
  left; only the message separates `rateLimited` from `quota`, and telling someone
  to "try again shortly" when they need to top up wastes their afternoon. Marks are
  validated **before** the key is, so an unmarked segment never turns into a demand
  for an API key.
- **Output is announced.** The description lands in an **assertive** live region in
  the player (the user asked for it and is waiting; a polite one would queue behind
  running captions) and stays on screen in a labelled panel that also shows the
  marked range, so it can be re-read. Marks, errors and progress announce through a
  separate polite region.

Needs system **ffmpeg**/**ffprobe** and the `@google/genai` package. Note that
`@google/genai` and `protobufjs` are pinned **`false`** in `pnpm-workspace.yaml`'s
`allowBuilds` — their install hooks are a no-op echo and a CLI shim respectively,
neither needed to call the REST API.

### Sidecar subtitles (.srt / .vtt)

A media file gets subtitles by having a **sibling `.srt` or `.vtt`** next to it. Nothing is registered or embedded; dropping the file next to the media is the whole contract, which is also why it works for one file *inside* a chaptered/DAISY folder as much as for a standalone file, and why an extracted `movie.eng.srt` needs no further wiring.

**Which file is picked** is `pickSubtitleFile()` — pure, so the (fiddly) ranking is unit-tested without a filesystem. Exact names win outright, in the order `<base>.srt`, `<base>.vtt`, `<name.ext>.srt`, `<name.ext>.vtt` (the `Chapter 1.mp3.srt` form some rippers write). **Only then does prefix matching run**: any track whose name merely *starts* with the media name — `movie-forced.srt`, `movie.en.vtt`, `movie.mp4.es.srt` — because that is how downloaded and extracted tracks are actually named. Prefix matching is guarded two ways, or it would hand a file the wrong track: a candidate whose stem is **another file's own name is skipped entirely** (in a folder of `ep1.mp3` … `ep10.mp3`, `ep10.srt` can never be given to `ep1.mp3`), and what remains is ranked by whether the extra text starts at a **qualifier boundary** (`. - _ ( [`), then by how little was added, then by format.

- **`GET /api/media/subtitles?path=…`** → `{available, path?, format?, cues:[{start,end,text}]}`. It answers `{available:false, cues:[]}` — never an error — when there's no track, because the player asks for every file it loads. `$server/services/subtitles.ts` does the work: the sibling directory is listed **once** and compared case-insensitively and NFC-normalized (accented names are stored NFD as often as NFC), then parsed and cached per file keyed on size + mtime. **`format` is the only thing that distinguishes srt from vtt in the response** — cues are identical, so the whole client (store, caption box, live region, `S` shortcut) is format-agnostic and needed no change to gain WebVTT.
- **One forgiving parser serves both formats** (`parseSubtitles(input, 'srt'|'vtt')`, unit-tested in `subtitles.test.ts`): cues are found by their *timing line* rather than by blank-line blocks, so files with missing indices or missing separators still parse. It accepts `.` or `,` before the milliseconds, short ms fields, the hour-less `MM:SS,mmm` form, CRLF, and strips `<i>`/`<font>` tags, `{\an8}` ASS overrides and HTML entities. WebVTT then needs almost nothing extra — trailing cue settings (`align:start position:10%`) are ignored because the timing pattern only claims the front of the line, and `<v Speaker>`/`<c.loud>`/`<00:00:01.000>` spans fall to the existing tag strip. The two real differences are **format-gated**: `NOTE`/`STYLE`/`REGION` blocks are skipped wholesale, and the line before a timing line is dropped as a **cue identifier** (in SubRip only a bare *number* is, since a `.srt` cue's last line may legitimately butt up against the next timing line). Encoding follows the DAISY rule — UTF-16 by BOM, else UTF-8, else windows-1252 when UTF-8 yields replacement chars (Spanish/French .srt files are routinely latin-1). Anything unparseable yields `[]`: subtitles must never break playback.
- **Cue times are file-relative**, i.e. the same clock as `playerStore.currentTime` — *not* the book's absolute timeline that chapters use. `$lib/stores/subtitles.svelte.ts` holds the whole track in memory and binary-searches it per tick; `PlaybackView` reloads it whenever `playerStore.currentFile` changes, so a book picks up each file's own track as it advances. Overlapping cues resolve to the one that started last.
- **UI** (`PlaybackView`): a caption box above the seek bar, plus a **live region** that is the screen-reader copy of the same text — the visible box is `aria-hidden` while the live region is carrying it, so the line isn't duplicated in the buffer. Both politeness levels are rendered as separate sr-only regions (swapping `aria-live` on a live element is unreliable) and only the selected one ever receives text. **`assertive` is the default**: each caption supersedes the previous one, whereas `polite` queues them and drifts further behind the audio the more dialogue there is — settings offer `polite` and `off` (visual only). The `Subtitles` footer button and the **`S`** shortcut toggle the `subtitlesEnabled` setting, and both only appear/act when the file actually has a track (`S` on a track-less file announces that instead).

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

Bare **`s`** toggles subtitles in the media player (see "Sidecar subtitles"); it sits in the default `switch`, so `winampShortcuts` doesn't claim it. So do **`d`** / **`Shift+D`** / **`Ctrl+Shift+D`** (mark start, mark end, describe — see "Video description"), which are inert unless the loaded file is a video.

**Next/previous track (media player)** lives in `PlaybackView.switchTrack(±1)`: it lists the current file's folder siblings via `/api/files` (`isPlayableMedia`, i.e. audio + browser-playable video, natural sort), finds the current file, and `goto()`s the neighbour. It **never crosses folder boundaries and never wraps** past the first/last file (no-op at the edge). Chaptered folders instead map `b`/`z` to `nextChapter`/`previousChapter` (stays within the folder unit); radio is a no-op. Auto-advance reuses this same helper via the store's **`onTrackEnded`** callback — the store owns "a track ended", the view owns routing + sibling listing. To keep playing across the switch regardless of the `autoplay` setting, set **`playerStore.playOnNextLoad = true`** before navigating (`loadFile` consumes it, one-shot). The play route (`/play/[...path]/+page.svelte`) wraps `<PlaybackView>` in `{#key filePath}` so a track switch fully remounts (onMount reloads + plays the new file).

**Next/previous track (book reader)** — `b`/`z` navigate **by chapter**: `ReaderView.nextTrack()`/`prevTrack()` delegate to the reader store's `nextHeading()`/`prevHeading()` (chapters == heading chunks), which resume reading if we were already playing (mirrors the media player). The reader's `x`/`c`/`v` are fully functional too.

**Chapter navigation (media player)** — the Chapters button sits beside the bookmark ("markers") buttons in the footer and appears whenever `playerStore.chapters.length > 0` (embedded chapters, DAISY, or a chaptered folder alike). `ChapterList` mirrors `BookmarkList`'s listbox pattern: roving tabindex, Up/Down/Home/End, Enter/Space to jump, Escape to close, focus opening on the *playing* chapter and returning to the button on close (`aria-selected` marks the current chapter, not merely the focused row). Shortcut: **`c`** opens the list. With `winampShortcuts` on, bare `c` is play/pause and is claimed by the Winamp block first — **`Shift+C`** always reaches the chapter list, so it stays keyboard-reachable either way.

**Chapter as a seek unit** — when the media has chapters, the seek-unit radio group gains a **"Chapter"** option after the time units (index `CHAPTER_UNIT_INDEX === SEEK_UNITS.length`; `seekUnitIndex` persists to `localStorage['ecobox-seek-unit-index']` as before). With it selected, `ArrowLeft`/`ArrowRight` and the inner transport buttons call `previousChapter()`/`nextChapter()` instead of `seekRelative(±seconds)` — `PlaybackControls` takes optional `seekLabel`/`seekBackAria`/`seekForwardAria` overrides for the non-numeric badge. Selection degrades safely: `isChapterSeek` requires chapters to actually exist, so a file without them falls back to time seeking (a saved chapter index doesn't strand the arrows).

### Recent tab

The file browser is a two-tab view (`FileExplorer`, WAI-ARIA tablist with roving
tabindex + arrow/Home/End): **Files** (the folder browser) and **Recent**. Files is
always selected on load, and **Alt+1 / Alt+2** jump to a tab from anywhere on the
page — matched on `e.code` as well as `e.key`, since Alt+digit emits a symbol on
several layouts.

Where focus lands depends on how the tab was chosen, and the split is deliberate:
moving *within* the tablist (arrows/Home/End) keeps focus on the tab, the standard
pattern that keeps the tabs navigable, while **Alt+1 / Alt+2 land straight in that
tab's list** — that is where the user is going, and Shift+Tab still reaches the
tabs. The shortcut awaits the recent list's fetch before focusing (on the first
Alt+2 the rows don't exist yet) and falls back to focusing the tab when the list is
empty, so focus is never stranded on `<body>`. `Ctrl+L` focuses whichever list is
showing. Both panels stay mounted with the inactive one `hidden`, so returning to
Files doesn't re-run its focus-the-first-row effect and steal focus off the tab.

What gets recorded is what was **opened as a playable/readable unit** — an audio
file, a radio station, a DAISY/`.CHAPTERED` folder (`PlaybackView`), or a converted
book (`ReaderView`) — never plain folder browsing. Recording is a fire-and-forget
`POST /api/recent` from `recentStore.record()`: opening media must never fail
because bookkeeping did. The path is the primary key, so re-opening a file moves it
up rather than duplicating it, and `accessed_at` is **milliseconds** (unlike the
second-resolution timestamps elsewhere) so two files opened in the same second still
sort in order. The table is capped at `MAX_RECENT` rows, oldest pruned.

**`GET /api/recent`** resolves every entry to a `target` that exists *right now*:
`resolveRecentTarget` walks the path and then its ancestors until something is
found, terminating at the media root — so an entry can never dead-end. Deleting
`Show/Season 01/ep08.mp3` leaves the entry opening `Show/Season 01`; deleting that
folder too opens `Show`; with everything gone it opens home. The surviving ancestor
is routed by what it is **now** (a folder that became a book folder opens in the
reader), and such rows are flagged "no longer available" plus where they will open
instead, in both the visible text and the accessible name. Protected content is
filtered exactly as in `/api/files`: a locked session never lists a protected entry,
and the fallback walk skips protected ancestors rather than routing into them. The
walk takes injectable `describe` / `isHidden` so the rule is unit-tested without a
filesystem or a database (`recentFiles.test.ts`).

### Creating folders

The **Alt+N** actions menu has a **New folder** item (last, so Alt+N still opens on
"Upload files"), which opens `NewFolderDialog` and creates the folder inside the
folder currently being browsed via **`POST /api/files {path, name}`**.

`name` is a single segment, validated by the pure `validateFolderName()` in
`files.ts` (unit-tested in `files.test.ts`) and refused with a machine code the
client localizes — `empty` / `invalidChars` / `reserved` / `tooLong`, plus `exists`
(409) for a name already taken. The rules are stricter than POSIX on purpose:
besides the separators (a name that spans directories would place the folder
somewhere else), the Windows-illegal set `\ / : * ? " < > |`, control characters,
trailing dots/spaces and the legacy device names (`CON`, `NUL`, `COM1`…) are
rejected, because a library made here must stay creatable on a Windows install.
`createFolder()` resolves the parent through `resolveExistingPath` (so an accented
NFD-on-disk folder is found from the NFC path a browser sends) and calls `mkdir`
**non-recursively**, so a collision surfaces as EEXIST instead of silently
succeeding. A locked session gets the same 404 as `GET` for a protected parent.

Focus after the dialog always lands in the **list**, not back on the actions button:
cancelling focuses the current row, and creating reloads the listing and focuses the
**new folder's row** (announced through the live region), so Enter walks straight
into it.

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
- `ai_credentials` — API keys for server-side AI providers (`google`), used by video description. Never serialized to the client.
- `settings` — key-value settings storage
- `book_metadata` — reading position (current chunk index) for converted books
- `recent_files` — recently opened media, one row per path (see "Recent tab"). Rows
  deliberately survive the file's deletion, so `dbCleanup` must keep ignoring this table.

### Environment Variables
```
MEDIA_ROOT=/path/to/media       # Root directory for media files
DATABASE_URL=file:./data/ecobox.db
PORT=3000
ORIGIN=https://your-domain.com  # For production CORS
GEMINI_API_KEY=AIza...           # Optional: video description (else asked for in-app)
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
