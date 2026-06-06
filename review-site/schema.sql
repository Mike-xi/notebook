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

-- 用户在线创建的课程（HTML 正文直接存库；file 以 "u-" 前缀标识为动态课程）
-- 注：functions/api/courses.js 会用 CREATE TABLE IF NOT EXISTS 懒创建，无需手动迁移
CREATE TABLE IF NOT EXISTS courses (
  file        TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  subject     TEXT,
  description TEXT,
  icon        TEXT,
  color       TEXT,
  tags        TEXT,
  html        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
