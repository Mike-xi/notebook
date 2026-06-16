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
       category    TEXT NOT NULL DEFAULT 'learn',
       status      TEXT NOT NULL DEFAULT 'approved',
       created_at  INTEGER NOT NULL
     )`
  ).run();
  // 给历史表补 kind / category / status 列；若已存在会抛 duplicate column，忽略即可
  try {
    await env.DB.prepare("ALTER TABLE courses ADD COLUMN kind TEXT NOT NULL DEFAULT 'html'").run();
  } catch {}
  try {
    await env.DB.prepare("ALTER TABLE courses ADD COLUMN category TEXT NOT NULL DEFAULT 'learn'").run();
  } catch {}
  // status：approved=公开可见、pending=游客上传待管理员审核。历史数据默认 approved，不受影响
  try {
    await env.DB.prepare("ALTER TABLE courses ADD COLUMN status TEXT NOT NULL DEFAULT 'approved'").run();
  } catch {}
  schemaReady = true;
}

// 课程正文（html/md）存储：小文本存 D1 courses.html 列；超过阈值改存 R2（key=file slug），
// 列留空作为「正文在 R2」的标记。D1 单值上限 ~2MB，故大网页（自包含 HTML 等）必须走 R2。
export const D1_TEXT_MAX = 1_400_000;

// 写：返回应存入 courses.html 列的值（小文本=原文；大文本=''，正文已写 R2）。
export async function storeCourseText(env, file, text) {
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > D1_TEXT_MAX) {
    const ctype = file.endsWith('.md') ? 'text/markdown; charset=utf-8' : 'text/html; charset=utf-8';
    await env.FILES.put(file, text, { httpMetadata: { contentType: ctype } });
    return '';
  }
  // 小文本入 D1；顺手清掉可能存在的旧 R2 副本（编辑后变小的情况）
  try { await env.FILES.delete(file); } catch {}
  return text;
}

// 读：列非空=正文在 D1；列为空=正文在 R2（按 file slug 取）。
export async function loadCourseText(env, file, htmlCol) {
  if (htmlCol && htmlCol.length) return htmlCol;
  try { const obj = await env.FILES.get(file); return obj ? await obj.text() : ''; }
  catch { return ''; }
}

// 云盘目录树：R2 存文件字节（drive/<随机key>），D1 记录目录结构与元数据。
// path 为全路径（如 docs/sub/file.pdf），parent 为所在文件夹（'' 表示根），便于列目录与重命名/移动。
let driveReady = false;
export async function ensureDriveSchema(env) {
  if (driveReady) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS drive_nodes (
       id         INTEGER PRIMARY KEY AUTOINCREMENT,
       parent     TEXT NOT NULL DEFAULT '',
       name       TEXT NOT NULL,
       path       TEXT NOT NULL UNIQUE,
       is_dir     INTEGER NOT NULL DEFAULT 0,
       size       INTEGER NOT NULL DEFAULT 0,
       mime       TEXT NOT NULL DEFAULT '',
       r2_key     TEXT NOT NULL DEFAULT '',
       visible    INTEGER NOT NULL DEFAULT 0,
       created_at INTEGER NOT NULL
     )`
  ).run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_drive_parent ON drive_nodes(parent)').run();
  // visible：0=仅管理员可见、1=对外（一二级）可见。新上传默认 0。历史表懒迁移加列
  try { await env.DB.prepare('ALTER TABLE drive_nodes ADD COLUMN visible INTEGER NOT NULL DEFAULT 0').run(); } catch {}
  driveReady = true;
}

// 云盘分享链接（有状态，可撤销/计数）：token 指向某个文件或文件夹，可设过期/密码/下载上限。
let driveSharesReady = false;
export async function ensureDriveSharesSchema(env) {
  if (driveSharesReady) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS drive_shares (
       token       TEXT PRIMARY KEY,
       path        TEXT NOT NULL,
       is_dir      INTEGER NOT NULL DEFAULT 0,
       name        TEXT NOT NULL,
       pwd         TEXT NOT NULL DEFAULT '',
       expires_at  INTEGER NOT NULL DEFAULT 0,
       max_dl      INTEGER NOT NULL DEFAULT 0,
       downloads   INTEGER NOT NULL DEFAULT 0,
       created_at  INTEGER NOT NULL
     )`
  ).run();
  driveSharesReady = true;
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

// AI 对话历史：scope 区分会话（课程用 file，全能问答用 'omni'），保留约 30 天。
let chatReady = false;
export async function ensureChatSchema(env) {
  if (chatReady) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS chat_history (
       id         INTEGER PRIMARY KEY AUTOINCREMENT,
       scope      TEXT NOT NULL,
       role       TEXT NOT NULL,
       content    TEXT NOT NULL,
       created_at INTEGER NOT NULL
     )`
  ).run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_chat_scope ON chat_history(scope, created_at)').run();
  chatReady = true;
}

const CHAT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;   // 保留约一个月

// 读取某会话近一个月的历史（按时间升序）。失败返回空数组。
export async function getChatMessages(env, scope, limit = 60) {
  try {
    if (!env?.DB || !scope) return [];
    await ensureChatSchema(env);
    const r = await env.DB.prepare(
      'SELECT role, content, created_at FROM chat_history WHERE scope = ? AND created_at >= ? ORDER BY created_at ASC LIMIT ?'
    ).bind(scope, Date.now() - CHAT_RETENTION_MS, limit).all();
    return r.results || [];
  } catch { return []; }
}

// 追加若干条消息，并以一定概率顺手清理过期历史。任何失败都吞掉，不影响对话主流程。
export async function appendChatMessages(env, scope, turns) {
  try {
    if (!env?.DB || !scope || !Array.isArray(turns) || !turns.length) return;
    await ensureChatSchema(env);
    const now = Date.now();
    const stmt = env.DB.prepare('INSERT INTO chat_history (scope, role, content, created_at) VALUES (?, ?, ?, ?)');
    const batch = turns
      .filter((t) => t && t.content)
      .map((t, i) => stmt.bind(
        scope,
        t.role === 'assistant' ? 'assistant' : 'user',
        String(t.content).slice(0, 8000),
        now + i,                       // +i 保证同批次插入的先后顺序
      ));
    if (batch.length) await env.DB.batch(batch);
    if (Math.random() < 0.2) {
      await env.DB.prepare('DELETE FROM chat_history WHERE created_at < ?').bind(now - CHAT_RETENTION_MS).run();
    }
  } catch {}
}

// 清空某会话的历史。
export async function clearChatMessages(env, scope) {
  try {
    if (!env?.DB || !scope) return;
    await ensureChatSchema(env);
    await env.DB.prepare('DELETE FROM chat_history WHERE scope = ?').bind(scope).run();
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
