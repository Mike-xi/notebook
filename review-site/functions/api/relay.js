// 云端转存（「下载中心」网页版的后端）：给一个直链，服务端自己去下，边下边写进云盘。
//
// 为什么不在浏览器里下完再上传：那样一份字节要走两趟（源站→你家宽带→再传回 Cloudflare），
// 校园网/家宽的上行是瓶颈，几百兆能传半天。放到边缘上转，源站→R2 全程走 Cloudflare 的骨干，
// 人可以直接关掉页面，回头再从云盘拿（云盘那条线是 CDN，下起来比源站快）。
//
// 进度：请求发起后立刻返回，真正的搬运挂在 waitUntil 里跑，字节数每 1.5 秒写一次 D1，
// 前端轮询 ?list=1 画进度条。任务表只是进度看板，文件本体还是落在各自云盘的正常位置。
//
// 三级都能用，但一二级要限速限量：这本质上是「让服务器替你访问任意 URL」的口子，
// 又跟大家共用同一条转存通道和同一块云盘空间，不设闸门一个人就能把线路和配额占满。
// 每一级的速度 / 单文件大小 / 每日总量 / 并发数都可调，存在 prefs 表里，只有管理员能改（见 LIMITS）。
import { getRole } from '../_lib/auth.js';
import { ensureDriveSchema, ensurePrefsSchema, logEvent } from '../_lib/db.js';
import { normPath, cleanName, joinPath, guessMime, newR2Key } from '../_lib/drive.js';

const XIPAN_ROOT = 'xipan/';
const DRIVE_QUOTA = 8 * 1024 * 1024 * 1024;      // 公共云盘 8 GB（与 drive/upload.js 一致）
const XIPAN_QUOTA = 2 * 1024 * 1024 * 1024;      // Xi Pan 2 GB（与 dav 一致）
const HARD_MAX = 512 * 1024 * 1024;              // 单任务硬上限：再大就该用本地下载器了
const PART = 8 * 1024 * 1024;                    // 分片大小（R2 多段上传除末段外不得小于 5 MiB）
const STALE_MS = 20 * 60 * 1000;                 // 超过这么久还在 running 的判定为掉线
const PROGRESS_MS = 1500;                        // 进度写库的最小间隔
const DAY_MS = 24 * 60 * 60 * 1000;

// 各级默认闸门。speed=MB/s、file=单文件 MB、daily=每日总量 MB、conc=同时在跑的任务数；
// 0 一律表示「不限」。管理员在下载中心页面里改，改完存进 prefs.relay_limits。
const LIMITS_KEY = 'relay_limits';
const DEFAULT_LIMITS = {
  guest:  { on: 1, speed: 3,  file: 200, daily: 1024, conc: 1 },
  friend: { on: 1, speed: 6,  file: 300, daily: 2048, conc: 2 },
  admin:  { on: 1, speed: 0,  file: 512, daily: 0,    conc: 4 },
};
const clampNum = (v, lo, hi, d) => {
  const n = Number(v);
  return isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n * 10) / 10)) : d;
};
function normLimits(raw) {
  const out = {};
  for (const role of ['guest', 'friend', 'admin']) {
    const d = DEFAULT_LIMITS[role];
    const s = (raw && raw[role]) || {};
    out[role] = {
      on: role === 'admin' ? 1 : (s.on === 0 || s.on === false ? 0 : 1),
      speed: clampNum(s.speed, 0, 100, d.speed),
      file: clampNum(s.file, 1, HARD_MAX / 1048576, d.file),
      daily: clampNum(s.daily, 0, 20480, d.daily),
      conc: clampNum(s.conc, 1, 8, d.conc),
    };
  }
  return out;
}
async function getLimits(env) {
  await ensurePrefsSchema(env);
  try {
    const r = await env.DB.prepare('SELECT value FROM prefs WHERE key = ?').bind(LIMITS_KEY).first();
    return normLimits(r && r.value ? JSON.parse(r.value) : null);
  } catch { return normLimits(null); }
}

const j = (data, status = 200) => Response.json(data, { status });

let relayReady = false;
async function ensureRelaySchema(env) {
  if (relayReady) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS relay_jobs (
       id         INTEGER PRIMARY KEY AUTOINCREMENT,
       url        TEXT NOT NULL,
       dest       TEXT NOT NULL DEFAULT 'drive',
       name       TEXT NOT NULL,
       path       TEXT NOT NULL DEFAULT '',
       size       INTEGER NOT NULL DEFAULT 0,
       got        INTEGER NOT NULL DEFAULT 0,
       status     TEXT NOT NULL DEFAULT 'running',
       error      TEXT NOT NULL DEFAULT '',
       role       TEXT NOT NULL DEFAULT 'admin',
       created_at INTEGER NOT NULL,
       updated_at INTEGER NOT NULL
     )`
  ).run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_relay_created ON relay_jobs(created_at DESC)').run();
  try { await env.DB.prepare("ALTER TABLE relay_jobs ADD COLUMN role TEXT NOT NULL DEFAULT 'admin'").run(); } catch {}
  relayReady = true;
}

// ---- URL 校验：只放行公网 http(s)，挡掉内网地址（服务端替人发请求，不能变成内网探针） ----
const BLOCKED_HOST = /^(localhost|.*\.local|.*\.internal|.*\.localhost)$/i;
function checkUrl(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { return { error: '不是合法的链接' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { error: '只支持 http / https 直链' };
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (BLOCKED_HOST.test(host)) return { error: '不允许的主机名' };
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const p = host.split('.').map(Number);
    const priv = p[0] === 10 || p[0] === 127 || p[0] === 0
      || (p[0] === 172 && p[1] >= 16 && p[1] <= 31)
      || (p[0] === 192 && p[1] === 168)
      || (p[0] === 169 && p[1] === 254)
      || (p[0] === 100 && p[1] >= 64 && p[1] <= 127);
    if (priv) return { error: '不允许的内网地址' };
  }
  if (host === '::1' || /^f[cd][0-9a-f]{2}:/i.test(host)) return { error: '不允许的内网地址' };
  return { url: u };
}

// 文件名：优先用 Content-Disposition，其次用 URL 末段，都没有就给个时间戳名字
function nameFrom(u, disposition) {
  const d = String(disposition || '');
  let n = '';
  const star = d.match(/filename\*\s*=\s*[^']*'[^']*'([^;]+)/i);
  const plain = d.match(/filename\s*=\s*"([^"]+)"|filename\s*=\s*([^;]+)/i);
  if (star) { try { n = decodeURIComponent(star[1].trim()); } catch { n = star[1].trim(); } }
  else if (plain) n = (plain[1] || plain[2] || '').trim();
  if (!n) {
    try { n = decodeURIComponent((u.pathname.split('/').pop() || '').trim()); } catch { n = ''; }
  }
  n = n.replace(/[\\/]/g, '_').replace(/[\x00-\x1f\x7f]/g, '').trim();
  return cleanName(n) || ('download-' + Date.now());
}

async function driveUsage(env) {
  const r = await env.DB.prepare('SELECT COALESCE(SUM(size),0) AS total FROM drive_nodes WHERE is_dir = 0').first();
  return r?.total || 0;
}
async function xipanUsage(env) {
  let total = 0, cursor;
  do {
    const out = await env.FILES.list({ prefix: XIPAN_ROOT, cursor, limit: 1000 });
    for (const o of (out.objects || [])) total += o.size || 0;
    cursor = out.truncated ? out.cursor : undefined;
  } while (cursor);
  return total;
}

export async function onRequest(context) {
  const { request, env } = context;
  if (!env.DB) return j({ error: 'D1 未配置' }, 500);
  const role = await getRole(request, env);
  if (!role) return j({ error: '请先登录' }, 401);
  const isAdmin = role === 'admin';
  await ensureRelaySchema(env);

  const url = new URL(request.url);
  if (request.method === 'GET') return await listJobs(env, role);
  if (request.method !== 'POST') return j({ error: 'Method Not Allowed' }, 405);

  let body = {};
  try { body = await request.json(); } catch {}
  const action = body.action || url.searchParams.get('action') || 'add';

  if (action === 'probe') return await probe(body.url);
  if (action === 'limits') {
    if (!isAdmin) return j({ error: '只有管理员能改限速' }, 403);
    const next = normLimits(body.limits);
    await ensurePrefsSchema(env);
    await env.DB.prepare(
      'INSERT INTO prefs (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).bind(LIMITS_KEY, JSON.stringify(next)).run();
    return j({ ok: true, limits: next });
  }
  if (action === 'clear') {
    // 一二级只清得掉自己那一级的记录
    if (isAdmin) await env.DB.prepare("DELETE FROM relay_jobs WHERE status != 'running'").run();
    else await env.DB.prepare("DELETE FROM relay_jobs WHERE status != 'running' AND role = ?").bind(role).run();
    return j({ ok: true });
  }
  if (action === 'cancel') {
    // 搬运在另一个执行上下文里，叫不停；只把这条记录收掉，run() 写完会发现记录没了
    const id = Number(body.id) || 0;
    if (isAdmin) await env.DB.prepare('DELETE FROM relay_jobs WHERE id = ?').bind(id).run();
    else await env.DB.prepare('DELETE FROM relay_jobs WHERE id = ? AND role = ?').bind(id, role).run();
    return j({ ok: true });
  }
  if (action !== 'add') return j({ error: '未知操作' }, 400);

  return await addJob(context, body, role);
}

async function listJobs(env, role) {
  const isAdmin = role === 'admin';
  // 掉线的任务（waitUntil 被掐、源站卡死）不会有人来收尾，列表里按超时标记掉
  await env.DB.prepare(
    "UPDATE relay_jobs SET status='error', error='超时中断（源站太慢或连接被掐）' WHERE status='running' AND updated_at < ?"
  ).bind(Date.now() - STALE_MS).run();
  // 管理员看全部任务，一二级只看自己那一级的（跟登录日志一个口径）
  const { results } = isAdmin
    ? await env.DB.prepare(
        'SELECT id, url, dest, name, path, size, got, status, error, role, created_at, updated_at FROM relay_jobs ORDER BY id DESC LIMIT 30'
      ).all()
    : await env.DB.prepare(
        'SELECT id, url, dest, name, path, size, got, status, error, role, created_at, updated_at FROM relay_jobs WHERE role = ? ORDER BY id DESC LIMIT 30'
      ).bind(role).all();

  const limits = await getLimits(env);
  const mine = limits[role] || DEFAULT_LIMITS.guest;
  const out = {
    ok: true,
    role,
    admin: isAdmin,
    jobs: results || [],
    limit: mine,                         // 自己这一级的闸门
    usedToday: await usedToday(env, role),
    running: await runningCount(env, role),
    usage: {
      drive: { used: await driveUsage(env), quota: DRIVE_QUOTA },
      xipan: { used: env.FILES ? await xipanUsage(env) : 0, quota: XIPAN_QUOTA },
    },
  };
  if (isAdmin) out.limits = limits;      // 三级才拿得到整张表（页面上要能改）
  return j(out);
}

// 今天这一级已经转了多少字节（按 24 小时滚动窗口，够用且不必存日历表）
async function usedToday(env, role) {
  const r = await env.DB.prepare(
    "SELECT COALESCE(SUM(CASE WHEN status='done' THEN size ELSE got END),0) AS n FROM relay_jobs WHERE role = ? AND created_at > ?"
  ).bind(role, Date.now() - DAY_MS).first();
  return r?.n || 0;
}
async function runningCount(env, role) {
  const r = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM relay_jobs WHERE role = ? AND status = 'running' AND updated_at > ?"
  ).bind(role, Date.now() - STALE_MS).first();
  return r?.n || 0;
}

// 先探一探：拿文件名、大小、类型，让人在真按下「转存」前知道要下的是什么
async function probe(raw) {
  const chk = checkUrl(raw);
  if (chk.error) return j({ error: chk.error }, 400);
  const u = chk.url;
  try {
    let res = await fetch(u.toString(), { method: 'HEAD', redirect: 'follow' });
    // 不少站不认 HEAD（返回 405/403），退回 GET 只取一个字节
    if (!res.ok || res.status === 405) {
      res = await fetch(u.toString(), { headers: { Range: 'bytes=0-0' }, redirect: 'follow' });
      try { await res.body?.cancel(); } catch {}
    }
    if (!res.ok && res.status !== 206) return j({ error: '源站返回 ' + res.status }, 400);
    let size = parseInt(res.headers.get('Content-Length') || '0', 10) || 0;
    const cr = res.headers.get('Content-Range');
    if (cr) { const m = cr.match(/\/(\d+)\s*$/); if (m) size = parseInt(m[1], 10) || 0; }
    return j({
      ok: true,
      name: nameFrom(new URL(res.url || u.toString()), res.headers.get('Content-Disposition')),
      size,
      type: res.headers.get('Content-Type') || '',
      final: res.url || u.toString(),
    });
  } catch (e) {
    return j({ error: '连不上：' + (e && e.message ? e.message : e) }, 400);
  }
}

async function addJob(context, body, role) {
  const { env } = context;
  if (!env.FILES) return j({ error: 'R2 未配置' }, 500);

  // ---- 闸门：本级是否开放、并发、每日总量 ----
  const limits = await getLimits(env);
  const lim = limits[role] || DEFAULT_LIMITS.guest;
  if (!lim.on) return j({ error: '管理员暂时关闭了这一级的云端转存' }, 403);
  if (await runningCount(env, role) >= lim.conc) {
    return j({ error: `同时最多跑 ${lim.conc} 个任务，等前一个完了再来` }, 429);
  }
  if (lim.daily) {
    const used = await usedToday(env, role);
    if (used >= lim.daily * 1048576) {
      return j({ error: `这一级 24 小时内最多转 ${lim.daily} MB，已经用掉 ${(used / 1048576).toFixed(0)} MB` }, 429);
    }
  }

  const chk = checkUrl(body.url);
  if (chk.error) return j({ error: chk.error }, 400);
  const dest = body.dest === 'xipan' ? 'xipan' : 'drive';
  if (dest === 'xipan' && role !== 'admin') return j({ error: 'Xi Pan 是私人云盘，只有管理员能存' }, 403);
  const parent = normPath(body.parent || '');
  if (parent === null) return j({ error: '非法的目标文件夹' }, 400);
  const name = body.name ? cleanName(body.name) : nameFrom(chk.url, '');
  if (!name) return j({ error: '非法的文件名' }, 400);
  const path = joinPath(parent, name);

  // 同名先挡掉，别等下完了才发现放不进去
  if (dest === 'drive') {
    await ensureDriveSchema(env);
    const exists = await env.DB.prepare('SELECT 1 FROM drive_nodes WHERE path = ?').bind(path).first();
    if (exists) return j({ error: '云盘里已有同名文件：' + path }, 409);
    if (parent) {
      const dir = await env.DB.prepare('SELECT is_dir FROM drive_nodes WHERE path = ?').bind(parent).first();
      if (!dir || !dir.is_dir) return j({ error: '目标文件夹不存在' }, 404);
    }
  } else if (await env.FILES.head(XIPAN_ROOT + path)) {
    return j({ error: 'Xi Pan 里已有同名文件：' + path }, 409);
  }

  const now = Date.now();
  const ins = await env.DB.prepare(
    'INSERT INTO relay_jobs (url, dest, name, path, size, got, status, error, role, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?)'
  ).bind(chk.url.toString(), dest, name, path, 'running', '', role, now, now).run();
  const id = ins.meta?.last_row_id;
  if (!id) return j({ error: '建任务失败' }, 500);

  // 真正的搬运放到响应之后跑，页面不用干等着
  context.waitUntil(run(env, id, chk.url.toString(), dest, parent, name, path, role, lim));
  return j({ ok: true, id, name, dest, path, limit: lim });
}

// ---- 搬运本体 ----
async function run(env, id, url, dest, parent, name, path, role, lim) {
  const bump = (fields, binds) => env.DB
    .prepare(`UPDATE relay_jobs SET ${fields}, updated_at = ? WHERE id = ?`)
    .bind(...binds, Date.now(), id).run().catch(() => {});
  const fail = async (msg) => { await bump("status = 'error', error = ?", [String(msg).slice(0, 200)]); };

  const quota = dest === 'drive' ? DRIVE_QUOTA : XIPAN_QUOTA;
  const used = dest === 'drive' ? await driveUsage(env) : await xipanUsage(env);
  const perFile = Math.min(HARD_MAX, (lim.file || 0) * 1048576 || HARD_MAX);
  const room = Math.max(0, Math.min(perFile, quota - used));
  if (room <= 0) return fail(dest === 'drive' ? '公共云盘已满' : 'Xi Pan 已满');
  // 限速：按「到现在为止本该花掉多少时间」补睡眠，把平均速率压在闸门以下。
  // 掐在读取端，源站那边的 TCP 窗口自然会收下来，不是先全速下完再假装慢。
  const rate = (lim.speed || 0) * 1048576;
  const t0 = Date.now();
  const throttle = async (got) => {
    if (!rate) return;
    const owe = (got / rate) * 1000 - (Date.now() - t0);
    if (owe > 20) await new Promise((r) => setTimeout(r, Math.min(3000, owe)));
  };

  let mp = null;
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; XiNotebook-Relay/1.0)', Accept: '*/*' },
    });
    if (!res.ok) throw new Error('源站返回 ' + res.status);
    if (!res.body) throw new Error('源站没给内容');
    const declared = parseInt(res.headers.get('Content-Length') || '0', 10) || 0;
    if (declared > room) throw new Error(sizeMsg(declared, room));
    if (declared) await bump('size = ?', [declared]);

    const r2Key = dest === 'drive' ? newR2Key() : XIPAN_ROOT + path;
    const mime = res.headers.get('Content-Type')?.split(';')[0].trim() || guessMime(name);
    const httpMetadata = { contentType: mime };

    // 小文件一次 put；大文件走多段上传（每段 8 MB，内存里最多只压着一段）
    const reader = res.body.getReader();
    let buf = [], bufLen = 0, total = 0, partNo = 1, last = 0;
    const parts = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > room) { try { await reader.cancel(); } catch {} throw new Error(sizeMsg(total, room)); }
      buf.push(value); bufLen += value.byteLength;
      if (bufLen >= PART) {
        if (!mp) mp = await env.FILES.createMultipartUpload(r2Key, { httpMetadata });
        parts.push(await mp.uploadPart(partNo++, concat(buf, bufLen)));
        buf = []; bufLen = 0;
      }
      const now = Date.now();
      if (now - last > PROGRESS_MS) {
        last = now;
        await bump('got = ?', [total]);
        // 页面上「取消」＝删记录；这边发现记录没了就收摊，别把字节继续往云盘里灌
        const alive = await env.DB.prepare('SELECT 1 FROM relay_jobs WHERE id = ?').bind(id).first().catch(() => ({}));
        if (!alive) { try { await reader.cancel(); } catch {} if (mp) { try { await mp.abort(); } catch {} } return; }
      }
      await throttle(total);
    }
    if (mp) {
      if (bufLen) parts.push(await mp.uploadPart(partNo++, concat(buf, bufLen)));
      await mp.complete(parts);
      mp = null;
    } else {
      await env.FILES.put(r2Key, concat(buf, bufLen), { httpMetadata });
    }

    // 落库：公共云盘要在 drive_nodes 里登记一条（Xi Pan 的 key 就是路径，不用登记）。
    // 一二级转进来的跟他们手动上传一个待遇：先进内容审核队列，管理员放行才公开。
    if (dest === 'drive') {
      await ensureDriveSchema(env);
      await env.DB.prepare(
        `INSERT INTO drive_nodes (parent, name, path, is_dir, size, mime, r2_key, visible, status, created_at)
         VALUES (?, ?, ?, 0, ?, ?, ?, 0, ?, ?)`
      ).bind(parent, name, path, total, mime, r2Key, role === 'admin' ? 'approved' : 'pending', Date.now()).run();
    }
    await bump("status = 'done', got = ?, size = ?", [total, total]);
    await logEvent(env, 'relay', JSON.stringify({ name, dest, size: total }).slice(0, 300));
  } catch (e) {
    if (mp) { try { await mp.abort(); } catch {} }
    await fail(e && e.message ? e.message : e);
  }
}

const sizeMsg = (n, room) =>
  `文件 ${(n / 1048576).toFixed(1)} MB，超出可用空间 ${(room / 1048576).toFixed(1)} MB（本级单文件上限 ${(room / 1048576).toFixed(0)} MB）`;

function concat(chunks, len) {
  const out = new Uint8Array(len);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}
