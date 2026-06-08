// 共享：懒创建/迁移 courses 表。isolate 内只跑一次（schemaReady 缓存）。
// 老库（无 kind 列）通过 ALTER ADD COLUMN 在线迁移，捕获「列已存在」错误。
let schemaReady = false;

export async function ensureCoursesSchema(env) {
  if (schemaReady) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS courses (
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
     )`
  ).run();
  // 给历史表补 kind 列；若已存在会抛 duplicate column，忽略即可
  try {
    await env.DB.prepare("ALTER TABLE courses ADD COLUMN kind TEXT NOT NULL DEFAULT 'html'").run();
  } catch {}
  schemaReady = true;
}

// 通用键值偏好表（单用户）。目前用于存课程显示顺序（key=course_order）。
let prefsReady = false;
export async function ensurePrefsSchema(env) {
  if (prefsReady) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS prefs (
       key   TEXT PRIMARY KEY,
       value TEXT NOT NULL DEFAULT ''
     )`
  ).run();
  prefsReady = true;
}

let hlReady = false;
export async function ensureHighlightsSchema(env) {
  if (hlReady) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS highlights (
       id         INTEGER PRIMARY KEY AUTOINCREMENT,
       file       TEXT NOT NULL,
       start_off  INTEGER NOT NULL,
       end_off    INTEGER NOT NULL,
       text       TEXT NOT NULL,
       color      TEXT NOT NULL DEFAULT 'yellow',
       note       TEXT NOT NULL DEFAULT '',
       created_at INTEGER NOT NULL
     )`
  ).run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_highlights_file ON highlights(file)').run();
  hlReady = true;
}
