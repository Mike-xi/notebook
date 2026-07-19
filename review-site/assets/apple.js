// 苹果比价前端：分类浏览 + 价格走势可视化（迷你折线 / 区间条 / 趋势大图）+ AI 预算顾问。
// 价格数据来自 /api/apple（Apple 中国官网起售价 + 太平洋电脑网参考价 + 人工核验），鉴权走站点登录 Cookie。
(function () {
  const $ = (id) => document.getElementById(id);
  const root = document.documentElement;
  const SOURCE_LABELS = { 'apple-cn': 'Apple 官网', pconline: '太平洋', manual: '人工核验' };
  const sourceLabel = (source) => SOURCE_LABELS[source] || '公开来源';

  // 主题跟随站点（auto 时监听系统变化）
  (function theme() {
    let t = 'auto'; try { t = localStorage.getItem('nb-theme') || 'auto'; } catch {}
    const apply = () => {
      const dark = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
      root.setAttribute('data-theme', dark ? 'dark' : 'light');
    };
    apply();
    if (t === 'auto' && matchMedia) try { matchMedia('(prefers-color-scheme: dark)').addEventListener('change', apply); } catch {}
  })();

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const yuan = (n) => '￥' + Number(n).toLocaleString('zh-CN');
  const toast = (t) => { const e = $('ap-toast'); e.textContent = t; e.classList.add('show'); clearTimeout(e._t); e._t = setTimeout(() => e.classList.remove('show'), 2000); };
  const fmtDate = (ts) => { const d = new Date(ts); return `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')}`; };
  const fmtRefreshed = (ts) => {
    if (!ts) return '尚未抓取';
    const diff = Date.now() - ts, h = Math.floor(diff / 3600000);
    if (h < 1) return '刚刚更新'; if (h < 24) return `${h} 小时前更新`;
    return `${Math.floor(h / 24)} 天前更新`;
  };

  // 跳转搜索模板（型号取首个左括号前，搜索更干净）
  function jumpLinks(p) {
    const cleanName = p.name.split('(')[0].trim();
    const q = encodeURIComponent('Apple ' + cleanName);
    const officialUrl = p.source === 'apple-cn' && p.url
      ? p.url
      : `https://www.apple.com.cn/search/${encodeURIComponent(cleanName)}`;
    const links = [
      ['官网', officialUrl],
      ['淘宝', `https://s.taobao.com/search?q=${q}`],
      ['京东', `https://search.jd.com/Search?keyword=${q}`],
      ['拼多多', `https://mobile.yangkeduo.com/search_result.html?search_key=${q}`],
    ];
    if (p.url && p.source === 'pconline') links.push(['太平洋', p.url]);
    else if (p.url && p.source === 'manual') links.push(['核验来源', p.url]);
    return links.map(([t, u]) => `<a class="ap-link" href="${esc(u)}" target="_blank" rel="noopener">${t}</a>`).join('');
  }

  // —— SVG 迷你折线（卡片） ——
  function sparkSVG(hist, cur) {
    const W = 300, H = 40, pad = 3;
    let pts = hist.map((h) => h.price);
    if (!pts.length) pts = [cur];
    if (pts.length === 1) pts = [pts[0], pts[0]];
    const min = Math.min(...pts), max = Math.max(...pts), range = (max - min) || 1, n = pts.length;
    const xy = pts.map((p, i) => [pad + (i / (n - 1)) * (W - 2 * pad), pad + (1 - (p - min) / range) * (H - 2 * pad)]);
    const dir = pts[n - 1] < pts[0] ? 'down' : pts[n - 1] > pts[0] ? 'up' : 'flat';
    const color = dir === 'down' ? 'var(--down)' : dir === 'up' ? 'var(--up)' : 'var(--muted)';
    const line = xy.map((c) => c.map((v) => v.toFixed(1)).join(',')).join(' ');
    const area = `${pad},${H - pad} ${line} ${(W - pad)},${H - pad}`;
    const last = xy[n - 1];
    return `<svg class="ap-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <polygon points="${area}" fill="${color}" opacity="0.10"/>
      <polyline points="${line}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="2.6" fill="${color}"/>
    </svg>`;
  }

  // —— SVG 趋势大图（modal） ——
  function trendChartSVG(p) {
    const hist = p.history.slice();
    if (hist.length < 1) hist.push({ price: p.price, ts: Date.now() });
    const W = 600, H = 240, L = 52, R = 14, T = 18, B = 30;
    const prices = hist.map((h) => h.price);
    const min = Math.min(...prices), max = Math.max(...prices), range = (max - min) || 1;
    const n = hist.length;
    const X = (i) => L + (n === 1 ? (W - L - R) / 2 : (i / (n - 1)) * (W - L - R));
    const Y = (v) => T + (1 - (v - min) / range) * (H - T - B);
    const line = hist.map((h, i) => `${X(i).toFixed(1)},${Y(h.price).toFixed(1)}`).join(' ');
    const area = `${X(0).toFixed(1)},${(H - B)} ${line} ${X(n - 1).toFixed(1)},${(H - B)}`;
    const dir = prices[n - 1] < prices[0] ? 'down' : prices[n - 1] > prices[0] ? 'up' : 'flat';
    const color = dir === 'down' ? 'var(--down)' : dir === 'up' ? 'var(--up)' : 'var(--accent)';
    // y 轴参考线：min / avg / max
    const avg = Math.round(prices.reduce((a, b) => a + b, 0) / n);
    const refs = [['min', min], ['avg', avg], ['max', max]];
    let grid = '';
    for (const [lab, v] of refs) {
      const y = Y(v).toFixed(1);
      grid += `<line x1="${L}" y1="${y}" x2="${W - R}" y2="${y}" stroke="var(--border)" stroke-dasharray="3 3"/>`
        + `<text x="${L - 6}" y="${(+y + 3).toFixed(1)}" text-anchor="end" font-size="10" fill="var(--muted)">${yuan(v)}</text>`;
    }
    // x 轴端点日期
    const xlabels = `<text x="${X(0).toFixed(1)}" y="${H - 8}" font-size="10" fill="var(--muted)">${fmtDate(hist[0].ts)}</text>`
      + (n > 1 ? `<text x="${X(n - 1).toFixed(1)}" y="${H - 8}" text-anchor="end" font-size="10" fill="var(--muted)">${fmtDate(hist[n - 1].ts)}</text>` : '');
    // 数据点（带原生 tooltip）
    const dots = hist.map((h, i) =>
      `<circle cx="${X(i).toFixed(1)}" cy="${Y(h.price).toFixed(1)}" r="3" fill="${color}"><title>${fmtDate(h.ts)}  ${yuan(h.price)}</title></circle>`
    ).join('');
    return `<svg class="ap-chart" viewBox="0 0 ${W} ${H}">
      ${grid}
      <polygon points="${area}" fill="${color}" opacity="0.10"/>
      <polyline points="${line}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round"/>
      ${dots}${xlabels}
    </svg>`;
  }

  // —— 状态 ——
  let DATA = { categories: [], sources: [], refreshed_at: 0 };
  let isAdmin = false;
  let activeCat = '';

  function changeBadge(p) {
    const s = p.stats;
    if (!s || s.n < 2) return `<span class="ap-change flat">新收录</span>`;
    const diff = p.price - s.prev;
    if (diff === 0) return `<span class="ap-change flat">持平</span>`;
    const cls = diff < 0 ? 'down' : 'up';
    const arrow = diff < 0 ? '↓' : '↑';
    return `<span class="ap-change ${cls}">${arrow} ${yuan(Math.abs(diff))}</span>`;
  }

  function rangeBar(p) {
    const s = p.stats;
    if (!s || s.max <= s.min) return '';
    const pos = Math.max(0, Math.min(100, ((p.price - s.min) / (s.max - s.min)) * 100));
    return `<div class="ap-rangebar" title="当前价在历史区间的位置（左=历史低）"><div class="ap-knob" style="left:${pos.toFixed(0)}%"></div></div>`;
  }

  function thirdHTML(p) {
    if (!p.third || !p.third.length) return '';
    const rows = p.third.map((t) => {
      const pr = t.url ? `<a class="ap-link" href="${esc(t.url)}" target="_blank" rel="noopener">${yuan(t.price)}</a>` : `<span class="pr">${yuan(t.price)}</span>`;
      const del = isAdmin ? ` <button class="ap-mini del" data-act="delThird" data-name="${esc(p.name)}" data-ch="${esc(t.channel)}">×</button>` : '';
      return `<div class="ap-tp"><span class="ch">${esc(t.channel)}</span><span class="pr">${pr}</span>${t.note ? `<span class="note">${esc(t.note)}</span>` : ''}${del}</div>`;
    }).join('');
    return `<div class="ap-third">${rows}</div>`;
  }

  function cardHTML(p) {
    const s = p.stats || {};
    const tracked = s.n >= 2 ? `已追踪 <b>${s.n}</b> 个价点` : '价格刚开始积累';
    const srcTag = `<span class="ap-tag-src">${esc(sourceLabel(p.source))}</span>`;
    const admin = isAdmin ? `<div class="ap-admin-row">
        <button class="ap-mini" data-act="addThird" data-name="${esc(p.name)}">＋ 渠道价</button>
        <button class="ap-mini del" data-act="delProduct" data-name="${esc(p.name)}">删除</button>
      </div>` : '';
    return `<div class="ap-card" data-name="${esc(p.name)}">
      <div class="ap-name">${esc(p.name)} ${srcTag}</div>
      <div class="ap-priceline">
        <span class="ap-price">${yuan(p.price)}</span>
        ${changeBadge(p)}
      </div>
      ${sparkSVG(p.history || [], p.price)}
      ${rangeBar(p)}
      <div class="ap-stats">
        <span>区间 <b>${yuan(s.min ?? p.price)}</b>–<b>${yuan(s.max ?? p.price)}</b></span>
        <span>均价 <b>${yuan(s.avg ?? p.price)}</b></span>
        <span>${tracked}</span>
        <span><a href="#" class="ap-link ap-trend" data-name="${esc(p.name)}">📈 趋势</a></span>
      </div>
      <div class="ap-links">${jumpLinks(p)}</div>
      ${thirdHTML(p)}
      ${admin}
    </div>`;
  }

  function renderTabs() {
    const tabs = $('ap-tabs');
    if (!DATA.categories.length) { tabs.innerHTML = ''; return; }
    if (!activeCat || !DATA.categories.find((c) => c.key === activeCat)) activeCat = DATA.categories[0].key;
    tabs.innerHTML = DATA.categories.map((c) =>
      `<button class="ap-tab ${c.key === activeCat ? 'active' : ''}" data-cat="${c.key}">${esc(c.label)} <span style="opacity:.6">${c.products.length}</span></button>`
    ).join('');
  }

  function renderGrid() {
    const grid = $('ap-grid'), empty = $('ap-empty');
    const cat = DATA.categories.find((c) => c.key === activeCat);
    if (!DATA.categories.length) {
      grid.innerHTML = ''; empty.hidden = false;
      empty.innerHTML = isAdmin
        ? '还没有价格数据。点右上角「↻ 抓取刷新」，将从 Apple 中国官网与太平洋电脑网同步真实公开价格。'
        : '价格数据正在准备中，请稍后再来看看～';
      return;
    }
    empty.hidden = true;
    grid.innerHTML = (cat ? cat.products : []).map(cardHTML).join('');
  }

  function render() {
    const labels = (DATA.sources || []).map((source) => source.label).filter(Boolean);
    const sourceSummary = labels.length ? labels.join(' · ') : 'Apple 中国官网 · 太平洋电脑网';
    $('ap-refreshed').textContent = `· ${fmtRefreshed(DATA.refreshed_at)} · 数据源 ${sourceSummary}`;
    renderTabs();
    renderGrid();
  }

  async function load() {
    try {
      const r = await fetch('/api/apple', { headers: { Accept: 'application/json' } });
      if (!r.ok) { toast('加载失败'); return; }
      DATA = await r.json();
      isAdmin = !!(DATA.me && DATA.me.admin);
      if (isAdmin) { $('ap-admin-flag').hidden = false; $('ap-refresh-btn').hidden = false; $('ap-add-btn').hidden = false; }
      render();
    } catch { toast('网络错误'); }
  }

  // —— modal 基础 ——
  function openModal(html) {
    const root = $('ap-modal-root');
    root.innerHTML = `<div class="ap-mask">${html}</div>`;
    const mask = root.firstElementChild;
    mask.addEventListener('click', (e) => { if (e.target === mask) closeModal(); });
    return mask;
  }
  function closeModal() { $('ap-modal-root').innerHTML = ''; }

  function openTrend(name) {
    const p = findProduct(name); if (!p) return;
    const s = p.stats || {};
    openModal(`<div class="ap-modal">
      <div class="ap-mtitle"><h3>${esc(p.name)} · 价格走势</h3><button class="ap-x" data-x>×</button></div>
      ${trendChartSVG(p)}
      <div class="ap-stats" style="margin-top:8px">
        <span>当前 <b>${yuan(p.price)}</b></span>
        <span>历史最低 <b>${yuan(s.min ?? p.price)}</b></span>
        <span>历史最高 <b>${yuan(s.max ?? p.price)}</b></span>
        <span>均价 <b>${yuan(s.avg ?? p.price)}</b></span>
      </div>
      <div class="ap-adv-note">当前来源：${esc(sourceLabel(p.source))}。公开价格每日同步；点位越多趋势越准。</div>
    </div>`);
  }

  function findProduct(name) {
    for (const c of DATA.categories) { const p = c.products.find((x) => x.name === name); if (p) return p; }
    return null;
  }

  // —— 管理员：录入产品 ——
  function openAddProduct() {
    openModal(`<div class="ap-modal">
      <div class="ap-mtitle"><h3>录入产品（手动）</h3><button class="ap-x" data-x>×</button></div>
      <div class="ap-adv-note" style="margin-bottom:10px">五大分类已接入官网自动同步；这里仅用于补充已人工核验的特殊型号或渠道。</div>
      <div class="ap-form-grid">
        <div><label>分类</label><select id="ap-f-cat">
          <option value="ipad">iPad</option><option value="airpods">AirPods</option>
          <option value="iphone">iPhone</option><option value="mac">Mac</option>
          <option value="watch">Apple Watch</option><option value="other">其他</option>
        </select></div>
        <div><label>价格（元）</label><input id="ap-f-price" type="number" min="0" placeholder="如 4599"></div>
        <div class="full"><label>型号名称</label><input id="ap-f-name" type="text" placeholder="如 iPad Air 11 (M3/128GB)"></div>
        <div class="full"><label>详情链接（可选）</label><input id="ap-f-url" type="text" placeholder="https://"></div>
      </div>
      <div class="ap-actions">
        <button class="ap-btn" data-x>取消</button>
        <button class="ap-btn ap-primary" id="ap-f-save">保存</button>
      </div>
    </div>`);
    $('ap-f-save').addEventListener('click', async () => {
      const payload = {
        action: 'addProduct',
        category: $('ap-f-cat').value,
        name: $('ap-f-name').value.trim(),
        price: $('ap-f-price').value,
        url: $('ap-f-url').value.trim(),
      };
      if (!payload.name || !payload.price) { toast('型号与价格必填'); return; }
      await postManage(payload, '已保存');
    });
  }

  function openAddThird(name) {
    openModal(`<div class="ap-modal">
      <div class="ap-mtitle"><h3>添加渠道价</h3><button class="ap-x" data-x>×</button></div>
      <div class="ap-adv-note" style="margin-bottom:10px">${esc(name)}</div>
      <div class="ap-form-grid">
        <div><label>渠道</label><input id="ap-t-ch" type="text" placeholder="淘宝 / 京东 / 拼多多"></div>
        <div><label>价格（元）</label><input id="ap-t-price" type="number" min="0"></div>
        <div class="full"><label>链接（可选）</label><input id="ap-t-url" type="text" placeholder="https://"></div>
        <div class="full"><label>备注（可选）</label><input id="ap-t-note" type="text" placeholder="如 百亿补贴 / 国补后"></div>
      </div>
      <div class="ap-actions">
        <button class="ap-btn" data-x>取消</button>
        <button class="ap-btn ap-primary" id="ap-t-save">保存</button>
      </div>
    </div>`);
    $('ap-t-save').addEventListener('click', async () => {
      const payload = {
        action: 'setThird', name,
        channel: $('ap-t-ch').value.trim(), price: $('ap-t-price').value,
        url: $('ap-t-url').value.trim(), note: $('ap-t-note').value.trim(),
      };
      if (!payload.channel || !payload.price) { toast('渠道与价格必填'); return; }
      await postManage(payload, '已保存');
    });
  }

  async function postManage(payload, okMsg) {
    try {
      const r = await fetch('/api/apple', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const d = await r.json();
      if (!r.ok) { toast(d.error || '操作失败'); return; }
      closeModal(); toast(okMsg || '完成'); await load();
    } catch { toast('网络错误'); }
  }

  async function doRefresh() {
    const btn = $('ap-refresh-btn');
    btn.disabled = true; const old = btn.textContent; btn.innerHTML = '<span class="ap-spinner"></span> 抓取中…';
    try {
      const r = await fetch('/api/apple/refresh', { method: 'POST', headers: { Accept: 'application/json' } });
      const d = await r.json();
      if (!r.ok) { toast(d.error || '刷新失败'); return; }
      const c = d.changes || {};
      const warning = d.errors && d.errors.length ? `，${d.errors.length} 项源异常待重试` : '';
      toast(`已刷新：新增 ${c.new || 0}，降价 ${c.down || 0}，涨价 ${c.up || 0}${warning}`);
      await load();
    } catch { toast('网络错误'); } finally { btn.disabled = false; btn.textContent = old; }
  }

  // —— AI 预算顾问 ——
  async function analyze() {
    const budget = parseInt($('ap-budget').value, 10);
    if (!Number.isFinite(budget) || budget <= 0) { toast('请输入预算'); return; }
    const box = $('ap-adv-result');
    box.hidden = false;
    box.innerHTML = `<div class="ap-adv-summary"><span class="ap-spinner"></span> 正在结合价格走势与发布/大促周期分析…</div>`;
    const btn = $('ap-analyze'); btn.disabled = true;
    try {
      const r = await fetch('/api/apple/advisor', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ budget, category: $('ap-cat-sel').value, prefer: $('ap-prefer').value.trim() }),
      });
      const d = await r.json();
      if (!r.ok) { box.innerHTML = `<div class="ap-adv-summary">${esc(d.error || '分析失败')}</div>`; return; }
      renderAdvice(d);
    } catch { box.innerHTML = `<div class="ap-adv-summary">网络错误，请稍后再试</div>`; } finally { btn.disabled = false; }
  }

  function renderAdvice(d) {
    const box = $('ap-adv-result');
    const picks = (d.picks || []).map((p) =>
      `<div class="ap-pick">
        <span class="ap-verdict v-${esc(p.verdict)}">${esc(p.verdict)}</span>
        <span class="ap-pick-name">${esc(p.name)}</span>
        <span class="ap-pick-price">${yuan(p.price)}</span>
        <span class="ap-pick-reason">${esc(p.reason)}</span>
      </div>`).join('');
    const timing = (d.timing || []).map((t) =>
      `<div class="ap-tw"><b>${esc(t.window)}</b><span>${esc(t.advice)}</span></div>`).join('');
    const srcTag = d.source === 'ai' ? '<span class="ap-tag-src">AI 分析</span>' : '<span class="ap-tag-src">规则建议</span>';
    box.innerHTML =
      `<div class="ap-adv-summary">${esc(d.summary || '')} ${srcTag}</div>`
      + (picks ? `<div class="ap-picks">${picks}</div>` : '')
      + (timing ? `<div class="ap-sub" style="margin-bottom:6px">⏱ 出手时机</div><div class="ap-timing">${timing}</div>` : '')
      + (d.note ? `<div class="ap-adv-note">⚠ ${esc(d.note)}</div>` : '');
  }

  // —— 事件 ——
  document.addEventListener('click', (e) => {
    const tab = e.target.closest('.ap-tab');
    if (tab) { activeCat = tab.dataset.cat; render(); return; }
    const trend = e.target.closest('.ap-trend');
    if (trend) { e.preventDefault(); openTrend(trend.dataset.name); return; }
    if (e.target.closest('[data-x]')) { closeModal(); return; }
    const act = e.target.closest('[data-act]');
    if (act) {
      const a = act.dataset.act, name = act.dataset.name;
      if (a === 'addThird') openAddThird(name);
      else if (a === 'delProduct') { if (confirm(`删除「${name}」？`)) postManage({ action: 'delProduct', name }, '已删除'); }
      else if (a === 'delThird') { if (confirm('删除该渠道价？')) postManage({ action: 'delThird', name, channel: act.dataset.ch }, '已删除'); }
      return;
    }
  });
  $('ap-analyze').addEventListener('click', analyze);
  $('ap-budget').addEventListener('keydown', (e) => { if (e.key === 'Enter') analyze(); });
  $('ap-refresh-btn').addEventListener('click', doRefresh);
  $('ap-add-btn').addEventListener('click', openAddProduct);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

  // 调试钩子
  window.__apple = { reload: load, data: () => DATA, isAdmin: () => isAdmin, analyze };

  load();
})();
