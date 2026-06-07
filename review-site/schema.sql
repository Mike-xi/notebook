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

-- 高亮/批注：按笔记正文的字符偏移(start_off/end_off)定位（内容静态，重开可还原）
-- 注：functions/_lib/db.js 会懒创建本表
CREATE TABLE IF NOT EXISTS highlights (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  file       TEXT NOT NULL,
  start_off  INTEGER NOT NULL,
  end_off    INTEGER NOT NULL,
  text       TEXT NOT NULL,
  color      TEXT NOT NULL DEFAULT 'yellow',
  note       TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_highlights_file ON highlights(file);

-- 用户在线创建的课程（file 以 "u-" 前缀标识为动态课程，扩展名表示类型）
-- kind: 'html' | 'md' 正文存 html 列（文本，≤1.5MB）；'pdf' 正文存 R2，html 列留空
-- 注：functions/_lib/db.js 会懒创建/迁移本表（CREATE IF NOT EXISTS + ALTER ADD kind），无需手动迁移
CREATE TABLE IF NOT EXISTS courses (
  file        TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  subject     TEXT,
  description TEXT,
  icon        TEXT,
  color       TEXT,
  tags        TEXT,
  html        TEXT NOT NULL DEFAULT '',
  kind        TEXT NOT NULL DEFAULT 'html',
  created_at  INTEGER NOT NULL
);
