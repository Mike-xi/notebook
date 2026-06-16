// 用户在线创建的课程（内容存 D1 或 R2，file slug 以 "u-" 前缀 + 扩展名标识类型）
// GET    /api/courses                 -> 动态课程列表（不含正文）
// POST   /api/courses                 -> multipart/form-data: title, file(必填) + subject/description/icon/color/kind(可选)
//                                        也兼容旧的 JSON {title, html}（仅 html）
// DELETE /api/courses  {file}         -> 删除课程，清理其 R2 对象与进度/书签
// 鉴权由 _middleware.js 统一处理（只有登录用户能访问 /api/*）
import { ensureCoursesSchema, ensurePrefsSchema, logEvent } from '../_lib/db.js';
import { getRole } from '../_lib/auth.js';

// 编辑 / 删除课程是管理操作：游客（只读）一律拒绝。
// 上传创建则对所有登录用户开放——管理员（三级）直接上线，游客（一二级）进审核队列。
const requireAdmin = async (request, env) => (await getRole(request, env)) === 'admin';
const forbidden = () => Response.json({ error: '游客身份不能增删改课程' }, { status: 403 });

const HIDDEN_KEY = 'hidden_courses';   // 静态课程（courses.json，在 git 里无法物理删除）改为隐藏

const MAX_TEXT_BYTES = 1_500_000;   // html/md 存 D1，单值上限 2MB，留余量
const MAX_PDF_BYTES = 20_000_000;   // pdf 存 R2，限 20MB
const DEFAULT_ICON = { html: '📘', md: '📝', pdf: '📕' };
const DEFAULT_DESC = { html: '上传的复习笔记', md: '上传的 Markdown 笔记', pdf: '上传的 PDF 文档' };
const PALETTE = ['#6750A4', '#0EA5E9', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899', '#14B8A6'];
const CATEGORIES = ['learn', 'explore', 'play'];

const str = (v) => (typeof v === 'string' ? v : (v == null ? '' : String(v))).trim();
const err = (msg, status = 400) => Response.json({ error: msg }, { status });
const errSize = (bytes, max, label) =>
  err(`${label} 太大（${(bytes / 1e6).toFixed(2)} MB），请控制在 ${(max / 1e6).toFixed(1)} MB 以内`, 413);

function detectKind(name, explicit) {
  const e = (explicit || '').toString().toLowerCase();
  if (e === 'pdf' || e === 'md' || e === 'html') return e;
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (ext === 'pdf') return 'pdf';
  if (ext === 'md' || ext === 'markdown') return 'md';
  return 'html';
}

export async function onRequestGet({ env }) {
  await ensureCoursesSchema(env);
  // 仅返回已审核通过的课程；待审核（pending，游客上传）不出现在公开列表里
  const { results } = await env.DB.prepare(
    `SELECT file, title, subject, description, icon, color, tags, kind, category, created_at
     FROM courses WHERE status = 'approved' ORDER BY created_at DESC`
  ).all();
  const courses = (results || []).map((r) => ({
    file: r.file,
    title: r.title,
    subject: r.subject || '',
    description: r.description || '',
    icon: r.icon || DEFAULT_ICON[r.kind] || DEFAULT_ICON.html,
    color: r.color || PALETTE[0],
    tags: safeTags(r.tags),
    kind: r.kind || 'html',
    category: CATEGORIES.includes(r.category) ? r.category : 'learn',
    created_at: r.created_at,
    dynamic: true,
  }));
  return Response.json(courses);
}

export async function onRequestPost({ request, env }) {
  // 登录由中间件保证；管理员上传直接通过，游客上传进审核队列（pending）
  const role = await getRole(request, env);
  const status = role === 'admin' ? 'approved' : 'pending';
  await ensureCoursesSchema(env);

  const ct = request.headers.get('Content-Type') || '';
  let title, kind, contentText = '', pdfBuffer = null;
  let meta = {};

  if (ct.includes('multipart/form-data')) {
    let form;
    try { form = await request.formData(); }
    catch { return err('请求格式错误'); }

    title = str(form.get('title'));
    const file = form.get('file');
    if (!title) return err('请填写课程名称');
    if (!file || typeof file === 'string') return err('请选择要上传的文件');

    kind = detectKind(file.name || '', form.get('kind'));
    meta = {
      subject: str(form.get('subject')),
      description: str(form.get('description')),
      icon: str(form.get('icon')),
      color: str(form.get('color')),
      tags: form.get('tags'),
      category: str(form.get('category')),
    };

    if (kind === 'pdf') {
      pdfBuffer = await file.arrayBuffer();
      if (pdfBuffer.byteLength > MAX_PDF_BYTES) return errSize(pdfBuffer.byteLength, MAX_PDF_BYTES, 'PDF');
      if (pdfBuffer.byteLength === 0) return err('PDF 内容为空');
    } else {
      contentText = await file.text();
      if (!contentText.trim()) return err('文件内容为空');
      const bytes = new TextEncoder().encode(contentText).length;
      if (bytes > MAX_TEXT_BYTES) return errSize(bytes, MAX_TEXT_BYTES, kind === 'md' ? 'Markdown' : 'HTML');
    }
  } else {
    // 向后兼容旧客户端：JSON 仅支持 html 文本
    let body;
    try { body = await request.json(); }
    catch { return err('请求格式错误'); }
    title = str(body?.title);
    if (!title) return err('请填写课程名称');
    if (typeof body?.html !== 'string' || !body.html.trim()) return err('请上传文件');
    kind = 'html';
    contentText = body.html;
    const bytes = new TextEncoder().encode(contentText).length;
    if (bytes > MAX_TEXT_BYTES) return errSize(bytes, MAX_TEXT_BYTES, 'HTML');
    meta = { subject: str(body.subject), description: str(body.description), icon: str(body.icon), color: str(body.color), tags: body.tags, category: str(body.category) };
  }

  const ext = kind === 'pdf' ? 'pdf' : kind === 'md' ? 'md' : 'html';
  const file = `u-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}.${ext}`;

  // pdf 先落 R2；若失败不写库，避免出现指向空对象的孤儿课程
  if (kind === 'pdf') {
    try {
      await env.FILES.put(file, pdfBuffer, { httpMetadata: { contentType: 'application/pdf' } });
    } catch (e) {
      return err('PDF 存储失败（R2 未配置？）', 500);
    }
  }

  const finalIcon = meta.icon ? [...meta.icon].slice(0, 2).join('') : DEFAULT_ICON[kind];
  const finalColor = /^#[0-9a-fA-F]{6}$/.test(meta.color) ? meta.color : PALETTE[Math.floor(Math.random() * PALETTE.length)];
  const finalSubject = meta.subject.slice(0, 40) || '我的笔记';
  const finalDesc = meta.description.slice(0, 120) || DEFAULT_DESC[kind];
  const finalTags = JSON.stringify(parseTags(meta.tags));
  const finalCategory = CATEGORIES.includes(meta.category) ? meta.category : 'learn';

  await env.DB.prepare(
    `INSERT INTO courses (file, title, subject, description, icon, color, tags, html, kind, category, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(file, title.slice(0, 80), finalSubject, finalDesc, finalIcon, finalColor, finalTags, contentText, kind, finalCategory, status, Date.now()).run();

  await logEvent(env, status === 'pending' ? 'submit' : 'upload', `${kind} · ${title.slice(0, 60)}`);
  return Response.json({ ok: true, file, kind, pending: status === 'pending' });
}

// PUT /api/courses {file, content?, title?, subject?, description?} —— 站内编辑器保存
// 仅允许编辑动态 Markdown 课程（u-*.md，正文在 D1）。内容变更后阅读器会按 hash 自动重建 RAG 索引。
export async function onRequestPut({ request, env }) {
  if (!(await requireAdmin(request, env))) return forbidden();
  await ensureCoursesSchema(env);

  let body;
  try { body = await request.json(); }
  catch { return err('请求格式错误'); }

  const file = str(body?.file);
  if (!file.startsWith('u-')) return err('非法的课程标识');
  const row = await env.DB.prepare('SELECT kind FROM courses WHERE file = ?').bind(file).first();
  if (!row) return err('课程不存在', 404);
  if (row.kind !== 'md') return err('仅支持编辑 Markdown 笔记');

  const sets = [], binds = [];
  if (typeof body.content === 'string') {
    if (!body.content.trim()) return err('内容不能为空');
    const bytes = new TextEncoder().encode(body.content).length;
    if (bytes > MAX_TEXT_BYTES) return errSize(bytes, MAX_TEXT_BYTES, 'Markdown');
    sets.push('html = ?'); binds.push(body.content);
  }
  const title = str(body?.title);
  if (title) { sets.push('title = ?'); binds.push(title.slice(0, 80)); }
  if (typeof body?.subject === 'string') { sets.push('subject = ?'); binds.push(str(body.subject).slice(0, 40)); }
  if (typeof body?.description === 'string') { sets.push('description = ?'); binds.push(str(body.description).slice(0, 120)); }
  if (!sets.length) return err('没有要更新的内容');

  await env.DB.prepare(`UPDATE courses SET ${sets.join(', ')} WHERE file = ?`).bind(...binds, file).run();
  await logEvent(env, 'edit', `${file} · ${title.slice(0, 60)}`);
  return Response.json({ ok: true });
}

export async function onRequestDelete({ request, env }) {
  if (!(await requireAdmin(request, env))) return forbidden();
  await ensureCoursesSchema(env);

  let body;
  try { body = await request.json(); }
  catch { return err('请求格式错误'); }

  const file = body?.file;
  if (typeof file !== 'string' || !file || file.length > 200 || file.includes('/')) {
    return err('非法的课程标识');
  }

  if (file.startsWith('u-')) {
    // 动态课程：内容在 D1/R2，物理删除
    await env.DB.prepare('DELETE FROM courses WHERE file = ?').bind(file).run();
    if (file.endsWith('.pdf')) {
      try { await env.FILES.delete(file); } catch {}
    }
  } else {
    // 静态课程：内容在 courses.json（git 里），无法物理删除，改为加入隐藏列表（首页据此过滤）
    await ensurePrefsSchema(env);
    const row = await env.DB.prepare('SELECT value FROM prefs WHERE key = ?').bind(HIDDEN_KEY).first();
    let hidden = [];
    try { const p = JSON.parse(row?.value || '[]'); if (Array.isArray(p)) hidden = p.filter((x) => typeof x === 'string'); } catch {}
    if (!hidden.includes(file)) hidden.push(file);
    await env.DB.prepare(
      'INSERT INTO prefs (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).bind(HIDDEN_KEY, JSON.stringify(hidden.slice(0, 500))).run();
  }

  // 清理关联进度 / 书签 / 高亮，尽力而为
  try { await env.DB.prepare('DELETE FROM progress WHERE file = ?').bind(file).run(); } catch {}
  try { await env.DB.prepare('DELETE FROM bookmarks WHERE file = ?').bind(file).run(); } catch {}
  try { await env.DB.prepare('DELETE FROM highlights WHERE file = ?').bind(file).run(); } catch {}
  await logEvent(env, 'delete', file);
  return Response.json({ ok: true });
}

function safeTags(s) {
  try { const t = JSON.parse(s || '[]'); return Array.isArray(t) ? t : []; }
  catch { return []; }
}

// 接收前端传来的 tags（JSON 数组字符串、真数组或逗号分隔串），清洗为 ≤6 个、每个 ≤16 字
function parseTags(v) {
  let arr = [];
  if (Array.isArray(v)) arr = v;
  else if (typeof v === 'string' && v.trim()) {
    try { const p = JSON.parse(v); if (Array.isArray(p)) arr = p; else arr = v.split(/[,，]/); }
    catch { arr = v.split(/[,，]/); }
  }
  return arr
    .map((x) => (typeof x === 'string' ? x : String(x || '')).trim())
    .filter(Boolean)
    .map((x) => x.slice(0, 16))
    .slice(0, 6);
}
