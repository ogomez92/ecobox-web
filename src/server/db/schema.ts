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

export const settings = sqliteTable('settings', {
	key: text('key').primaryKey(),
	value: text('value').notNull()
});

export const protectedPaths = sqliteTable('protected_paths', {
	path: text('path').primaryKey(),
	createdAt: integer('created_at', { mode: 'timestamp' })
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
export type Setting = typeof settings.$inferSelect;
export type NewSetting = typeof settings.$inferInsert;
export type ProtectedPath = typeof protectedPaths.$inferSelect;
export type NewProtectedPath = typeof protectedPaths.$inferInsert;
