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

// 操作日志（登录 / 上传 / 删除…），供首页「全能问答」做全局上下文。
let logsReady = false;
export async function ensureLogsSchema(env) {
  if (logsReady) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS logs (
       id         INTEGER PRIMARY KEY AUTOINCREMENT,
       type       TEXT NOT NULL,
       detail     TEXT NOT NULL DEFAULT '',
       created_at INTEGER NOT NULL
     )`
  ).run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_logs_created ON logs(created_at DESC)').run();
  logsReady = true;
}

const LOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;   // 保留 30 天
const LOG_MAX_ROWS = 1000;                            // 兜底总量上限
// 记一条事件日志，并以一定概率顺手清理过期/超量日志（serverless 友好，无需 cron）。
// 任何失败都吞掉——日志只是辅助，绝不能影响登录/上传等主流程。
export async function logEvent(env, type, detail = '') {
  try {
    if (!env || !env.DB) return;
    await ensureLogsSchema(env);
    const now = Date.now();
    await env.DB.prepare('INSERT INTO logs (type, detail, created_at) VALUES (?, ?, ?)')
      .bind(String(type).slice(0, 32), String(detail || '').slice(0, 300), now).run();
    if (Math.random() < 0.15) {
      await env.DB.prepare('DELETE FROM logs WHERE created_at < ?').bind(now - LOG_RETENTION_MS).run();
      await env.DB.prepare(
        'DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY created_at DESC LIMIT ?)'
      ).bind(LOG_MAX_ROWS).run();
    }
  } catch {}
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
