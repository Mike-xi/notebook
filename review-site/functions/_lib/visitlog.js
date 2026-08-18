// 登录 / 访问日志的写入与解析。
//
// 为什么单独抽一个文件：写入方有两处（api/login.js 输密码那一刻、_middleware.js
// 带着有效 cookie 第一次来访），读取方是 api/logins.js，三边必须对同一套格式，
// 而这套格式还得兼容三种历史写法（见 parseDetail）。
//
// 新格式一律是 JSON，塞进 logs.detail：{ r:role, p:place, i:ip, u:ua }
// —— 老格式用 ' · ' 分段，段数不定又和 UA 里的字符打架，加 IP 之后彻底不够用了。
const cut = (s, n) => String(s || '').slice(0, n);

// 取这次请求的来源信息。位置来自 Cloudflare 边缘的 request.cf（城市/国家）。
export function clientMeta(request) {
  const cf = request.cf || {};
  return {
    place: [cf.city, cf.region, cf.country].filter(Boolean).join(', ') || '未知',
    ip: request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || '',
    ua: request.headers.get('User-Agent') || '',
  };
}

export function buildDetail(role, request) {
  const m = clientMeta(request);
  return JSON.stringify({ r: role, p: cut(m.place, 60), i: cut(m.ip, 45), u: cut(m.ua, 220) });
}

// 解析一行 detail，兼容三代格式：
//   ① {"r":..,"p":..,"i":..,"u":..}      当前
//   ② "role · city, country · ua"        加了位置、没有 IP
//   ③ "role · ua"                        最早
export function parseDetail(detail) {
  const s = String(detail || '');
  if (s.charCodeAt(0) === 123 /* { */) {
    try {
      const o = JSON.parse(s);
      return { role: o.r || 'guest', place: o.p || '未知', ip: o.i || '', ua: o.u || '' };
    } catch { /* 落到下面按老格式解 */ }
  }
  const parts = s.split(' · ');
  const hasPlace = parts.length >= 3;
  return {
    role: parts[0] || 'guest',
    place: hasPlace ? parts[1] : '未知',
    ip: '',
    ua: (hasPlace ? parts.slice(2) : parts.slice(1)).join(' · '),
  };
}

// User-Agent -> { kind:'phone'|'tablet'|'desktop', name:'Chrome · Windows' }
// 手机/平板要单独认出来：用户看日志时第一眼想区分的是「这条是不是我手机上的」。
export function deviceOf(ua) {
  const s = String(ua || '');
  if (!s) return { kind: 'desktop', name: '未知设备' };

  const isTablet = /iPad/i.test(s) || (/Android/i.test(s) && !/Mobile/i.test(s));
  const isPhone = !isTablet && (/iPhone|iPod|Windows Phone/i.test(s) || (/Android/i.test(s) && /Mobile/i.test(s)) || /Mobile Safari/i.test(s));
  const kind = isTablet ? 'tablet' : isPhone ? 'phone' : 'desktop';

  const os =
    /iPhone|iPad|iPod/i.test(s) ? 'iOS' :
    /Android[ /]?([\d.]+)?/i.test(s) ? ('Android' + (RegExp.$1 ? ' ' + RegExp.$1.split('.')[0] : '')) :
    /Windows NT 10\.0/i.test(s) ? 'Windows' :
    /Windows/i.test(s) ? 'Windows' :
    /Mac OS X|Macintosh/i.test(s) ? 'macOS' :
    /CrOS/i.test(s) ? 'ChromeOS' :
    /Linux/i.test(s) ? 'Linux' : '';

  // 国内的「手机登录」多半发生在微信/QQ 内置浏览器里，认出来比报 Safari 有用
  const browser =
    /MicroMessenger/i.test(s) ? '微信' :
    /QQ\/|QQBrowser/i.test(s) ? 'QQ' :
    /Quark/i.test(s) ? '夸克' :
    /UCBrowser|UBrowser/i.test(s) ? 'UC' :
    /Edg[A-Z]?\//i.test(s) ? 'Edge' :
    /OPR\/|Opera/i.test(s) ? 'Opera' :
    /Firefox\/|FxiOS/i.test(s) ? 'Firefox' :
    /CriOS\//i.test(s) ? 'Chrome' :
    /Chrome\//i.test(s) ? 'Chrome' :
    /Safari\/|AppleWebKit/i.test(s) ? 'Safari' :
    /curl\//i.test(s) ? 'curl' : '浏览器';

  return { kind, name: [browser, os].filter(Boolean).join(' · ') };
}
