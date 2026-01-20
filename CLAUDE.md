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

## Architecture

### Tech Stack
- **Framework**: SvelteKit with Node adapter (SSR)
- **Database**: SQLite via better-sqlite3, ORM via Drizzle
- **Styling**: Tailwind CSS
- **State**: Svelte 5 runes ($state, $derived) in class-based stores

### Key Path Aliases
- `$lib` → `./src/lib`
- `$server` → `./src/server`

### Directory Structure
```
src/
├── lib/
│   ├── components/     # Svelte components (FileExplorer, PlaybackControls, etc.)
│   ├── stores/         # Reactive stores using Svelte 5 runes
│   │   ├── player.svelte.ts  # Audio playback state and controls
│   │   ├── files.svelte.ts   # File browser state
│   │   └── settings.svelte.ts
│   ├── services/       # Client-side services
│   │   └── audioEffects.ts   # Web Audio API effects chain
│   ├── types/          # TypeScript interfaces
│   └── utils/          # Utility functions (format.ts, etc.)
├── routes/
│   ├── api/            # REST API endpoints
│   │   ├── files/      # File listing, deletion
│   │   ├── media/      # Media streaming, metadata, chapters
│   │   ├── upload/     # Upload negotiation and streaming
│   │   ├── download/   # Single file and zip downloads
│   │   └── bookmarks/  # Bookmark CRUD
│   ├── browse/[...path]/ # File browser pages
│   ├── play/[...path]/   # Media player page
│   └── settings/         # Settings page
└── server/
    ├── db/             # Database schema and connection
    │   ├── schema.ts   # Drizzle schema definitions
    │   └── index.ts    # DB connection singleton
    └── services/       # Server-side services
        ├── files.ts    # File system operations (resolvePath, listDirectory, etc.)
        ├── daisy.ts    # DAISY audiobook format parser
        └── id3chapters.ts # ID3 chapter extraction
```

### Media Types
- **Single files**: Regular audio files (.mp3, .m4a, .m4b, etc.)
- **Chaptered folders**: Directories with `.CHAPTERED` marker file - treated as single playable unit
- **DAISY books**: Accessible audiobook format (detected by ncc.html/ncc.xml/Navigation.xml)
- **Radio files**: `.radio` files containing streaming URLs (JSON format)

### Database Schema
- `media_metadata` - Tracks playback position, duration, favorites
- `bookmarks` - Time-stamped bookmarks for single files
- `chaptered_metadata` - Playback state for multi-file chaptered content
- `chaptered_bookmarks` - Bookmarks within chaptered folders
- `settings` - Key-value settings storage

### Environment Variables
```
MEDIA_ROOT=/path/to/media   # Root directory for media files
DATABASE_URL=file:./data/ecobox.db
PORT=3000
ORIGIN=https://your-domain.com  # For production CORS
```

## Testing

Unit tests are co-located with source files using `.test.ts` suffix. Run specific tests with `npx vitest <path>`.
