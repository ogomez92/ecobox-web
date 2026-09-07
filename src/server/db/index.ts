import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';
import { env } from '$env/dynamic/private';
import path from 'path';
import fs from 'fs';

const dbPath = env.DATABASE_URL?.replace('file:', '') || './data/ecobox.db';

// Ensure directory exists
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
	fs.mkdirSync(dbDir, { recursive: true });
}

const sqlite = new Database(dbPath);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');

export const db = drizzle(sqlite, { schema });
export type Database = typeof db;

// Initialize tables
sqlite.exec(`
	CREATE TABLE IF NOT EXISTS media_metadata (
		path TEXT PRIMARY KEY,
		last_played_position REAL DEFAULT 0,
		duration REAL,
		is_favorite INTEGER DEFAULT 0,
		last_played_date INTEGER
	);

	CREATE TABLE IF NOT EXISTS bookmarks (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		media_path TEXT NOT NULL REFERENCES media_metadata(path) ON DELETE CASCADE,
		time REAL NOT NULL,
		label TEXT,
		created_at INTEGER NOT NULL
	);

	CREATE TABLE IF NOT EXISTS chaptered_metadata (
		folder_path TEXT PRIMARY KEY,
		current_file_path TEXT,
		current_file_position REAL DEFAULT 0,
		total_duration REAL
	);

	CREATE TABLE IF NOT EXISTS chaptered_bookmarks (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		folder_path TEXT NOT NULL REFERENCES chaptered_metadata(folder_path) ON DELETE CASCADE,
		file_path TEXT NOT NULL,
		time REAL NOT NULL,
		label TEXT,
		created_at INTEGER NOT NULL
	);

	CREATE TABLE IF NOT EXISTS protected_paths (
		path TEXT PRIMARY KEY,
		created_at INTEGER NOT NULL
	);

	CREATE TABLE IF NOT EXISTS media_durations (
		path TEXT PRIMARY KEY,
		duration REAL NOT NULL,
		size INTEGER NOT NULL,
		mtime INTEGER NOT NULL
	);

	CREATE TABLE IF NOT EXISTS settings (
		key TEXT PRIMARY KEY,
		value TEXT NOT NULL
	);

	CREATE TABLE IF NOT EXISTS book_metadata (
		book_folder_path TEXT PRIMARY KEY,
		current_chunk_index INTEGER DEFAULT 0,
		total_chunks INTEGER,
		last_read_date INTEGER,
		is_favorite INTEGER DEFAULT 0
	);

	CREATE TABLE IF NOT EXISTS book_bookmarks (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		book_folder_path TEXT NOT NULL,
		chunk_index INTEGER NOT NULL,
		label TEXT,
		created_at INTEGER NOT NULL
	);

	CREATE TABLE IF NOT EXISTS tts_credentials (
		service TEXT PRIMARY KEY,
		api_key TEXT,
		region TEXT,
		model TEXT,
		voice_id TEXT,
		enabled INTEGER DEFAULT 0,
		stability REAL,
		similarity_boost REAL,
		style REAL,
		use_speaker_boost INTEGER,
		elf_customize INTEGER,
		elf_head_size INTEGER,
		elf_pitch INTEGER,
		elf_inflection INTEGER,
		elf_roughness INTEGER,
		elf_breathiness INTEGER,
		elf_volume INTEGER
	);

	CREATE TABLE IF NOT EXISTS ai_credentials (
		provider TEXT PRIMARY KEY,
		api_key TEXT,
		updated_at INTEGER NOT NULL
	);

	CREATE TABLE IF NOT EXISTS deletion_history (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		path TEXT NOT NULL,
		name TEXT NOT NULL,
		is_directory INTEGER NOT NULL DEFAULT 0,
		source TEXT NOT NULL DEFAULT 'user',
		deleted_at INTEGER NOT NULL
	);

	CREATE TABLE IF NOT EXISTS recent_files (
		path TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		kind TEXT NOT NULL,
		accessed_at INTEGER NOT NULL
	);

	CREATE INDEX IF NOT EXISTS idx_recent_files_accessed ON recent_files(accessed_at DESC);
	CREATE INDEX IF NOT EXISTS idx_bookmarks_media_path ON bookmarks(media_path);
	CREATE INDEX IF NOT EXISTS idx_chaptered_bookmarks_folder ON chaptered_bookmarks(folder_path);
	CREATE INDEX IF NOT EXISTS idx_book_bookmarks_path ON book_bookmarks(book_folder_path);
`);

// Idempotent column additions for DBs created before a column existed.
// (CREATE TABLE IF NOT EXISTS above won't alter a pre-existing table.)
const deletionHistoryColumns = sqlite
	.prepare('PRAGMA table_info(deletion_history)')
	.all() as { name: string }[];
if (!deletionHistoryColumns.some((c) => c.name === 'source')) {
	sqlite.exec("ALTER TABLE deletion_history ADD COLUMN source TEXT NOT NULL DEFAULT 'user'");
}

// ElevenLabs voice_settings columns added after tts_credentials shipped.
const ttsCredentialColumns = sqlite
	.prepare('PRAGMA table_info(tts_credentials)')
	.all() as { name: string }[];
for (const [col, type] of [
	['stability', 'REAL'],
	['similarity_boost', 'REAL'],
	['style', 'REAL'],
	['use_speaker_boost', 'INTEGER'],
	// ELF voice parameter overrides added after tts_credentials shipped.
	['elf_customize', 'INTEGER'],
	['elf_head_size', 'INTEGER'],
	['elf_pitch', 'INTEGER'],
	['elf_inflection', 'INTEGER'],
	['elf_roughness', 'INTEGER'],
	['elf_breathiness', 'INTEGER'],
	['elf_volume', 'INTEGER']
] as const) {
	if (!ttsCredentialColumns.some((c) => c.name === col)) {
		sqlite.exec(`ALTER TABLE tts_credentials ADD COLUMN ${col} ${type}`);
	}
}

export { schema };
