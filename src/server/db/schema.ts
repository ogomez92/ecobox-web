import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';

export const mediaMetadata = sqliteTable('media_metadata', {
	path: text('path').primaryKey(),
	lastPlayedPosition: real('last_played_position').default(0),
	duration: real('duration'),
	isFavorite: integer('is_favorite', { mode: 'boolean' }).default(false),
	lastPlayedDate: integer('last_played_date', { mode: 'timestamp' })
});

export const bookmarks = sqliteTable('bookmarks', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	mediaPath: text('media_path')
		.notNull()
		.references(() => mediaMetadata.path, { onDelete: 'cascade' }),
	time: real('time').notNull(),
	label: text('label'),
	createdAt: integer('created_at', { mode: 'timestamp' })
		.notNull()
		.$defaultFn(() => new Date())
});

export const chapteredMetadata = sqliteTable('chaptered_metadata', {
	folderPath: text('folder_path').primaryKey(),
	currentFilePath: text('current_file_path'),
	currentFilePosition: real('current_file_position').default(0),
	totalDuration: real('total_duration')
});

export const chapteredBookmarks = sqliteTable('chaptered_bookmarks', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	folderPath: text('folder_path')
		.notNull()
		.references(() => chapteredMetadata.folderPath, { onDelete: 'cascade' }),
	filePath: text('file_path').notNull(),
	time: real('time').notNull(),
	label: text('label'),
	createdAt: integer('created_at', { mode: 'timestamp' })
		.notNull()
		.$defaultFn(() => new Date())
});

/**
 * Cached audio durations, keyed by media-root-relative path. `size`/`mtime` are
 * the cache key proper, so a replaced or edited file re-parses rather than
 * serving a stale length. Distinct from `mediaMetadata.duration`, which is the
 * user-facing row (position, favorite) and only exists once a file is played.
 */
export const mediaDurations = sqliteTable('media_durations', {
	path: text('path').primaryKey(),
	duration: real('duration').notNull(),
	size: integer('size').notNull(),
	mtime: integer('mtime').notNull()
});

export const settings = sqliteTable('settings', {
	key: text('key').primaryKey(),
	value: text('value').notNull()
});

export const bookMetadata = sqliteTable('book_metadata', {
	bookFolderPath: text('book_folder_path').primaryKey(),
	currentChunkIndex: integer('current_chunk_index').default(0),
	totalChunks: integer('total_chunks'),
	lastReadDate: integer('last_read_date', { mode: 'timestamp' }),
	isFavorite: integer('is_favorite', { mode: 'boolean' }).default(false)
});

export const bookBookmarks = sqliteTable('book_bookmarks', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	bookFolderPath: text('book_folder_path').notNull(),
	chunkIndex: integer('chunk_index').notNull(),
	label: text('label'),
	createdAt: integer('created_at', { mode: 'timestamp' })
		.notNull()
		.$defaultFn(() => new Date())
});

export const ttsCredentials = sqliteTable('tts_credentials', {
	// 'elevenlabs' | 'azure' | 'azure-edge' | 'google' | 'elf'
	service: text('service').primaryKey(),
	// SECRET — never serialized to the client (see /api/tts/config GET).
	apiKey: text('api_key'),
	region: text('region'),
	model: text('model'),
	voiceId: text('voice_id'),
	enabled: integer('enabled', { mode: 'boolean' }).default(false),
	// ElevenLabs voice_settings (null until the user tunes them).
	stability: real('stability'),
	similarityBoost: real('similarity_boost'),
	style: real('style'),
	useSpeakerBoost: integer('use_speaker_boost', { mode: 'boolean' }),
	// ELF voice parameter overrides (null until the user customizes them).
	elfCustomize: integer('elf_customize', { mode: 'boolean' }),
	elfHeadSize: integer('elf_head_size'),
	elfPitch: integer('elf_pitch'),
	elfInflection: integer('elf_inflection'),
	elfRoughness: integer('elf_roughness'),
	elfBreathiness: integer('elf_breathiness'),
	elfVolume: integer('elf_volume')
});

export const protectedPaths = sqliteTable('protected_paths', {
	path: text('path').primaryKey(),
	createdAt: integer('created_at', { mode: 'timestamp' })
		.notNull()
		.$defaultFn(() => new Date())
});

export const deletionHistory = sqliteTable('deletion_history', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	path: text('path').notNull(),
	name: text('name').notNull(),
	isDirectory: integer('is_directory', { mode: 'boolean' }).notNull().default(false),
	// How the deletion was triggered: an explicit user action, or a sync-mode upload.
	source: text('source', { enum: ['user', 'sync'] }).notNull().default('user'),
	deletedAt: integer('deleted_at', { mode: 'timestamp' })
		.notNull()
		.$defaultFn(() => new Date())
});

export type MediaMetadata = typeof mediaMetadata.$inferSelect;
export type NewMediaMetadata = typeof mediaMetadata.$inferInsert;
export type Bookmark = typeof bookmarks.$inferSelect;
export type NewBookmark = typeof bookmarks.$inferInsert;
export type ChapteredMetadata = typeof chapteredMetadata.$inferSelect;
export type NewChapteredMetadata = typeof chapteredMetadata.$inferInsert;
export type ChapteredBookmark = typeof chapteredBookmarks.$inferSelect;
export type NewChapteredBookmark = typeof chapteredBookmarks.$inferInsert;
export type MediaDuration = typeof mediaDurations.$inferSelect;
export type NewMediaDuration = typeof mediaDurations.$inferInsert;
export type Setting = typeof settings.$inferSelect;
export type NewSetting = typeof settings.$inferInsert;
export type BookMetadata = typeof bookMetadata.$inferSelect;
export type NewBookMetadata = typeof bookMetadata.$inferInsert;
export type BookBookmark = typeof bookBookmarks.$inferSelect;
export type NewBookBookmark = typeof bookBookmarks.$inferInsert;
export type TtsCredential = typeof ttsCredentials.$inferSelect;
export type NewTtsCredential = typeof ttsCredentials.$inferInsert;
export type ProtectedPath = typeof protectedPaths.$inferSelect;
export type NewProtectedPath = typeof protectedPaths.$inferInsert;
export type DeletionHistoryEntry = typeof deletionHistory.$inferSelect;
export type NewDeletionHistoryEntry = typeof deletionHistory.$inferInsert;
