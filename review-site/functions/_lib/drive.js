// 云盘路径工具：名称/路径清洗与拼接。R2 存文件字节、D1（drive_nodes）存目录树。
// 路径用正斜杠分隔、无前导/尾随斜杠，'' 表示根目录。

export const MAX_NAME = 120;

// 清洗单个文件/文件夹名；非法返回 null
export function cleanName(raw) {
  let n = String(raw == null ? '' : raw).trim();
  if (!n) return null;
  if (n === '.' || n === '..') return null;
  if (/[/\\]/.test(n)) return null;            // 不允许路径分隔符
  if (/[\x00-\x1f\x7f]/.test(n)) return null;   // 不允许控制字符
  if (n.length > MAX_NAME) n = n.slice(0, MAX_NAME);
  return n;
}

// 规范化整条路径；'' 合法（根），非法返回 null
export function normPath(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  if (s.length > 800) return null;
  const out = [];
  for (const seg of s.split('/')) {
    const c = cleanName(seg);
    if (!c) return null;
    out.push(c);
  }
  return out.join('/');
}

export function parentOf(path) {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

export function baseOf(path) {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

export function joinPath(parent, name) {
  return parent ? parent + '/' + name : name;
}

// 面包屑：根固定为「云盘」
export function breadcrumb(path) {
  const crumbs = [{ name: '云盘', path: '' }];
  if (!path) return crumbs;
  let acc = '';
  for (const seg of path.split('/')) {
    acc = acc ? acc + '/' + seg : seg;
    crumbs.push({ name: seg, path: acc });
  }
  return crumbs;
}

// 从文件名猜 MIME（用于下载/预览的 Content-Type）
const MIME = {
  pdf: 'application/pdf', html: 'text/html', htm: 'text/html', md: 'text/markdown', txt: 'text/plain',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav',
  json: 'application/json', csv: 'text/csv', zip: 'application/zip',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
export function guessMime(name) {
  const ext = (String(name).split('.').pop() || '').toLowerCase();
  return MIME[ext] || 'application/octet-stream';
}

// 生成唯一的 R2 对象 key（与路径解耦，重命名/移动无需搬运字节）
export function newR2Key() {
  return `drive/${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
