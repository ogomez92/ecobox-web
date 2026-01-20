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

	CREATE TABLE IF NOT EXISTS settings (
		key TEXT PRIMARY KEY,
		value TEXT NOT NULL
	);

	CREATE INDEX IF NOT EXISTS idx_bookmarks_media_path ON bookmarks(media_path);
	CREATE INDEX IF NOT EXISTS idx_chaptered_bookmarks_folder ON chaptered_bookmarks(folder_path);
`);

export { schema };
