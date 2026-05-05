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

After changing source code, deploying requires three steps:

```bash
npm run build
sudo systemctl restart ecobox
sudo chown -R ecobox .   # build/ and .svelte-kit/ are written as root if you ran npm as root
```

Hot dev (`npm run dev`) does not affect the running service — the service serves the last `build/` output.

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
