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
       status     TEXT NOT NULL DEFAULT 'approved',
       created_at INTEGER NOT NULL
     )`
  ).run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_drive_parent ON drive_nodes(parent)').run();
  // visible：0=仅管理员可见、1=对外（一二级）可见。新上传默认 0。历史表懒迁移加列
  try { await env.DB.prepare('ALTER TABLE drive_nodes ADD COLUMN visible INTEGER NOT NULL DEFAULT 0').run(); } catch {}
  // status：approved=正常文件、pending=一二级（guest）上传待管理员审核。历史数据默认 approved
  try { await env.DB.prepare("ALTER TABLE drive_nodes ADD COLUMN status TEXT NOT NULL DEFAULT 'approved'").run(); } catch {}
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

// 留言板（公共论坛）：所有登录用户共用一个版面，自选昵称留言、人人可见。
// 存明文 IP + user-agent，仅管理员能看（前端按角色显隐，接口按角色返回）。
let boardReady = false;
export async function ensureBoardSchema(env) {
  if (boardReady) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS board_messages (
       id         INTEGER PRIMARY KEY AUTOINCREMENT,
       nick       TEXT NOT NULL DEFAULT '',
       body       TEXT NOT NULL,
       ip         TEXT NOT NULL DEFAULT '',
       ua         TEXT NOT NULL DEFAULT '',
       created_at INTEGER NOT NULL
     )`
  ).run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_board_id ON board_messages(id)').run();
  boardReady = true;
}

const BOARD_MAX_ROWS = 5000;   // 论坛保留历史，仅设兜底总量上限防 D1 无限增长
// 以一定概率顺手清理超量留言（serverless 友好，无需 cron）。失败吞掉。
export async function pruneBoard(env) {
  try {
    if (Math.random() >= 0.05) return;
    await env.DB.prepare(
      'DELETE FROM board_messages WHERE id NOT IN (SELECT id FROM board_messages ORDER BY id DESC LIMIT ?)'
    ).bind(BOARD_MAX_ROWS).run();
  } catch {}
}

// 英汉词典：单词本（收藏）与查词历史，云端同步。owner=角色（admin/guest），各自一份。
// 收藏存释义快照（音标 p / 简短中文 t），列表页无需再拉分片即可渲染。
let dictReady = false;
export async function ensureDictSchema(env) {
  if (dictReady) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS dict_favorites (
       id         INTEGER PRIMARY KEY AUTOINCREMENT,
       owner      TEXT NOT NULL DEFAULT 'guest',
       word       TEXT NOT NULL,
       p          TEXT NOT NULL DEFAULT '',
       t          TEXT NOT NULL DEFAULT '',
       created_at INTEGER NOT NULL,
       UNIQUE(owner, word)
     )`
  ).run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_fav_owner ON dict_favorites(owner, created_at DESC)').run();
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS dict_history (
       id         INTEGER PRIMARY KEY AUTOINCREMENT,
       owner      TEXT NOT NULL DEFAULT 'guest',
       word       TEXT NOT NULL,
       created_at INTEGER NOT NULL,
       UNIQUE(owner, word)
     )`
  ).run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_hist_owner ON dict_history(owner, created_at DESC)').run();
  dictReady = true;
}

const HISTORY_MAX = 200;   // 每个 owner 仅保留最近 200 条查词历史
// 以一定概率顺手裁剪超量历史。失败吞掉。
export async function pruneDictHistory(env, owner) {
  try {
    if (Math.random() >= 0.1) return;
    await env.DB.prepare(
      `DELETE FROM dict_history WHERE owner = ? AND id NOT IN (
         SELECT id FROM dict_history WHERE owner = ? ORDER BY created_at DESC LIMIT ?
       )`
    ).bind(owner, owner, HISTORY_MAX).run();
  } catch {}
}

// 苹果比价：每日同步 Apple 中国官网起售价 + 太平洋电脑网参考价，并记录价格变化历史。
//  apple_products：当前在售产品当前价。source=apple-cn（官网）/pconline（第三方）/manual（人工核验）。
//  apple_history：每当某产品价格变化（或首次出现）记一条，做趋势折线/降涨标记/AI 出手时段分析。
//  apple_third：管理员手动维护的第三方渠道价（淘宝/京东/拼多多），按 (name,channel) 唯一。
let appleReady = false;
export async function ensureAppleSchema(env) {
  if (appleReady) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS apple_products (
       id         INTEGER PRIMARY KEY AUTOINCREMENT,
       category   TEXT NOT NULL DEFAULT 'iphone',
       name       TEXT NOT NULL UNIQUE,
       price      INTEGER NOT NULL DEFAULT 0,
       url        TEXT NOT NULL DEFAULT '',
       source     TEXT NOT NULL DEFAULT 'pconline',
       sort       INTEGER NOT NULL DEFAULT 0,
       updated_at INTEGER NOT NULL
     )`
  ).run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_apple_cat ON apple_products(category, sort)').run();
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS apple_history (
       id    INTEGER PRIMARY KEY AUTOINCREMENT,
       name  TEXT NOT NULL,
       price INTEGER NOT NULL,
       ts    INTEGER NOT NULL
     )`
  ).run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_apple_hist ON apple_history(name, ts)').run();
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS apple_third (
       name       TEXT NOT NULL,
       channel    TEXT NOT NULL,
       price      INTEGER NOT NULL DEFAULT 0,
       url        TEXT NOT NULL DEFAULT '',
       note       TEXT NOT NULL DEFAULT '',
       updated_at INTEGER NOT NULL,
       PRIMARY KEY (name, channel)
     )`
  ).run();
  appleReady = true;
}

// 手写笔记：owner=登录密码哈希（见 auth.js hashOwnerId），三个密码各自一份笔记本，互不可见。
// 笔画数据本身不进 D1（可能较大），存 R2（key=notepad/<owner>/page-<id>.json）；这里只存元数据+缩略图。
let notepadReady = false;
export async function ensureNotepadSchema(env) {
  if (notepadReady) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS notepad_books (
       id         INTEGER PRIMARY KEY AUTOINCREMENT,
       owner      TEXT NOT NULL,
       title      TEXT NOT NULL DEFAULT '未命名笔记本',
       color      TEXT NOT NULL DEFAULT '#f2c14e',
       paper      TEXT NOT NULL DEFAULT 'blank',
       sort       INTEGER NOT NULL DEFAULT 0,
       created_at INTEGER NOT NULL,
       updated_at INTEGER NOT NULL
     )`
  ).run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_notepad_books_owner ON notepad_books(owner, sort)').run();
  // cover：封面样式 id（对应 assets/notepad-covers/cover-XX.svg），空=纯色（用 color 列）。懒迁移加列
  try { await env.DB.prepare("ALTER TABLE notepad_books ADD COLUMN cover TEXT NOT NULL DEFAULT ''").run(); } catch {}
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS notepad_pages (
       id         INTEGER PRIMARY KEY AUTOINCREMENT,
       book_id    INTEGER NOT NULL,
       owner      TEXT NOT NULL,
       idx        INTEGER NOT NULL DEFAULT 0,
       paper      TEXT NOT NULL DEFAULT 'blank',
       thumb      TEXT NOT NULL DEFAULT '',
       updated_at INTEGER NOT NULL
     )`
  ).run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_notepad_pages_book ON notepad_pages(book_id, idx)').run();
  notepadReady = true;
}

const APPLE_HISTORY_MAX_PER = 400;   // 每个产品最多保留 400 条价格历史点（兜底防膨胀）
// 记录一次价格观测：仅当与该产品最近一条历史价不同（或首次）才写入，避免每日重复点。
// 返回 'new' | 'down' | 'up' | 'same'（相对上一价的变化方向，供调用方统计）。
export async function recordApplePrice(env, name, price) {
  try {
    const last = await env.DB.prepare(
      'SELECT price FROM apple_history WHERE name = ? ORDER BY ts DESC LIMIT 1'
    ).bind(name).first();
    if (last && last.price === price) return 'same';
    await env.DB.prepare('INSERT INTO apple_history (name, price, ts) VALUES (?, ?, ?)')
      .bind(name, price, Date.now()).run();
    if (Math.random() < 0.1) {
      await env.DB.prepare(
        `DELETE FROM apple_history WHERE name = ? AND id NOT IN (
           SELECT id FROM apple_history WHERE name = ? ORDER BY ts DESC LIMIT ?
         )`
      ).bind(name, name, APPLE_HISTORY_MAX_PER).run();
    }
    if (!last) return 'new';
    return price < last.price ? 'down' : 'up';
  } catch { return 'same'; }
}
