-- 阅读进度（每个文件只存一行，updated_at 用毫秒时间戳）
CREATE TABLE IF NOT EXISTS progress (
  file TEXT PRIMARY KEY,
  scroll_pct REAL NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 书签
CREATE TABLE IF NOT EXISTS bookmarks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file TEXT NOT NULL,
  title TEXT NOT NULL,
  scroll_pct REAL NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bookmarks_file ON bookmarks(file);
CREATE INDEX IF NOT EXISTS idx_progress_updated ON progress(updated_at DESC);
