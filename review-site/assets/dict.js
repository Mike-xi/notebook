// 英汉词典前端：按首两字母分片懒加载查词；联想 / 发音 / 收藏 / 历史 / 单词本（云端同步）/ AI 深度解析。
// 词库分片为 /dict/<bucket>.json，bucket = 单词小写前两个字符（第二位非字母数字记作 _）。
(function () {
  const $ = (id) => document.getElementById(id);
  const qEl = $('q'), goEl = $('go'), clearqEl = $('clearq'), suggestEl = $('suggest');
  const resultEl = $('result'), welcomeEl = $('welcome');

  // 主题跟随站点
  (function theme() {
    let t = 'auto';
    try { t = localStorage.getItem('nb-theme') || 'auto'; } catch {}
    const dark = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.body.classList.toggle('dark', dark);
  })();

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function toast(t) { const e = $('toast'); e.textContent = t; e.classList.add('show'); clearTimeout(e._t); e._t = setTimeout(() => e.classList.remove('show'), 1800); }

  // ---------- 状态 ----------
  const DICT_V = '20260619a';     // 词库数据版本；重新生成分片时同步 bump，强制刷新缓存
  const shardCache = new Map();   // bucket -> object | null(404)
  const aiCache = new Map();      // word -> markdown
  let favMap = new Map();         // word -> {p,t,created_at}
  let history = [];               // [{word, created_at}]
  let curWord = '';

  function bucketFor(w) {
    const s = w.toLowerCase();
    const c1 = s[0] || '_';
    let c2 = s[1] || '_';
    if (!/[a-z0-9]/.test(c2)) c2 = '_';
    return c1 + c2;
  }

  async function loadShard(bucket) {
    if (shardCache.has(bucket)) return shardCache.get(bucket);
    let data = null;
    try {
      const r = await fetch('/dict/' + bucket + '.json?v=' + DICT_V, { headers: { 'Accept': 'application/json' } });
      if (r.ok) data = await r.json();
    } catch {}
    shardCache.set(bucket, data);
    return data;
  }

  // ---------- 发音 ----------
  function speak(word, type) {
    // type 1=英音 2=美音；优先有道发音，失败回退浏览器 TTS
    let played = false;
    try {
      const a = new Audio('https://dict.youdao.com/dictvoice?audio=' + encodeURIComponent(word) + '&type=' + type);
      a.play().then(() => { played = true; }).catch(() => ttsFallback(word, type));
    } catch { ttsFallback(word, type); }
  }
  function ttsFallback(word, type) {
    try {
      if (!window.speechSynthesis) return;
      const u = new SpeechSynthesisUtterance(word);
      u.lang = type === 1 ? 'en-GB' : 'en-US';
      speechSynthesis.cancel(); speechSynthesis.speak(u);
    } catch {}
  }

  // ---------- 词形变化 ----------
  const EX_LABEL = { p: '过去式', d: '过去分词', i: '现在分词', '3': '第三人称单数', r: '比较级', t: '最高级', s: '复数', '0': '原形' };
  const EX_ORDER = ['0', 's', 'p', 'd', 'i', '3', 'r', 't'];
  function renderForms(x) {
    if (!x) return '';
    const map = {};
    x.split('/').forEach((part) => {
      const i = part.indexOf(':'); if (i < 0) return;
      const code = part.slice(0, i), val = part.slice(i + 1).trim();
      if (code === '1' || !val) return;     // 1=词根变化类型，跳过
      if (EX_LABEL[code]) map[code] = val;
    });
    const chips = EX_ORDER.filter((c) => map[c]).map((c) =>
      `<span class="form"><b>${EX_LABEL[c]}</b><a data-w="${esc(map[c])}">${esc(map[c])}</a></span>`);
    return chips.length ? `<div class="forms">${chips.join('')}</div>` : '';
  }

  // ---------- 徽标 ----------
  const TAG_LABEL = { zk: '中考', gk: '高考', cet4: '四级', cet6: '六级', ky: '考研', toefl: '托福', ielts: '雅思', gre: 'GRE' };
  function renderBadges(e) {
    const out = [];
    if (e.c) out.push(`<span class="stars" title="柯林斯星级 ${e.c}/5">${'★'.repeat(e.c)}${'☆'.repeat(5 - e.c)}</span>`);
    if (e.o) out.push(`<span class="badge oxf">牛津3000</span>`);
    if (e.g) e.g.split(/\s+/).forEach((t) => { if (TAG_LABEL[t]) out.push(`<span class="badge exam">${TAG_LABEL[t]}</span>`); });
    if (e.f) out.push(`<span class="badge frq">词频 #${e.f}</span>`);
    return out.length ? `<div class="badges">${out.join('')}</div>` : '';
  }

  // ---------- 渲染释义 ----------
  function renderEntry(word, entries) {
    curWord = word;
    welcomeEl.hidden = true;
    const head = entries[0];
    const isFav = favMap.has(word);
    let html = `<div class="entry">`;
    html += `<div class="hw"><span class="word">${esc(word)}</span>`;
    html += `<button class="fav-btn ${isFav ? 'on' : ''}" id="favbtn" title="收藏到单词本">${isFav ? '★' : '☆'}</button></div>`;
    if (head.p) {
      html += `<div class="phon"><span class="ipa">/${esc(head.p)}/</span>`
        + `<button class="spk" data-type="1">🔊 英</button><button class="spk" data-type="2">🔊 美</button></div>`;
    } else {
      html += `<div class="phon"><button class="spk" data-type="1">🔊 英</button><button class="spk" data-type="2">🔊 美</button></div>`;
    }
    html += renderBadges(head);

    entries.forEach((e, idx) => {
      if (entries.length > 1) html += `<div class="multi-note">释义 ${idx + 1}${e.w !== word ? '（' + esc(e.w) + '）' : ''}</div>`;
      html += `<div class="sense"><h4>中文释义</h4><div class="trans">${esc(e.t)}</div></div>`;
      if (e.d) html += `<div class="sense"><h4>英文释义（双解）</h4><div class="endef">${esc(e.d)}</div></div>`;
      if (e.x) html += renderForms(e.x);
    });

    html += `<div class="ai-bar"><button class="ai-btn" id="aibtn">✨ AI 深度解析</button></div>`;
    html += `<div class="ai-panel" id="aipanel" hidden></div>`;
    html += `</div>`;
    resultEl.innerHTML = html;

    // 事件
    $('favbtn').addEventListener('click', () => toggleFav(word, head));
    resultEl.querySelectorAll('.spk').forEach((b) => b.addEventListener('click', () => speak(word, +b.dataset.type)));
    resultEl.querySelectorAll('.form a[data-w]').forEach((a) => a.addEventListener('click', () => lookup(a.dataset.w)));
    $('aibtn').addEventListener('click', () => runAI(word, head));
    if (aiCache.has(word)) showAI(aiCache.get(word));
  }

  function renderNotFound(word, shard) {
    welcomeEl.hidden = true;
    let near = '';
    if (shard) {
      const lw = word.toLowerCase();
      const keys = Object.keys(shard).filter((k) => k.startsWith(lw)).slice(0, 8);
      if (keys.length) near = `<div class="quick-chips">${keys.map((k) => `<span class="qc" data-w="${esc(shard[k][0].w)}">${esc(shard[k][0].w)}</span>`).join('')}</div>`;
    }
    resultEl.innerHTML = `<div class="placeholder"><div class="big">🔍</div>未收录 <b>${esc(word)}</b>${near ? '<br>你是不是要查：' : ''}${near}</div>`;
    resultEl.querySelectorAll('.qc[data-w]').forEach((c) => c.addEventListener('click', () => lookup(c.dataset.w)));
  }

  // ---------- 查词 ----------
  async function lookup(raw, opts) {
    const word = String(raw || '').trim();
    if (!word) return;
    hideSuggest();
    qEl.value = word;
    clearqEl.hidden = !word;
    switchTab('result');
    const shard = await loadShard(bucketFor(word));
    const entries = shard && shard[word.toLowerCase()];
    if (entries && entries.length) {
      // 用词库里的原形大小写
      renderEntry(entries[0].w === word ? word : (entries.find((e) => e.w === word)?.w || entries[0].w), entries);
      if (!opts || !opts.noHistory) recordHistory(curWord);
      const enc = encodeURIComponent(curWord);
      if (location.hash.slice(1) !== enc) { suppressHash = true; location.hash = enc; }
    } else {
      renderNotFound(word, shard);
    }
    main.scrollTo({ top: 0 });
  }
  const main = document.querySelector('main');

  // ---------- 联想 ----------
  let suggIdx = -1, suggWords = [];
  async function updateSuggest() {
    const q = qEl.value.trim().toLowerCase();
    clearqEl.hidden = !qEl.value;
    if (q.length < 2) { hideSuggest(); return; }
    const shard = await loadShard(bucketFor(q));
    if (!shard) { hideSuggest(); return; }
    if (qEl.value.trim().toLowerCase() !== q) return;   // 已变更，丢弃
    const matches = [];
    for (const k in shard) if (k.startsWith(q)) matches.push(k);
    matches.sort((a, b) => {
      const fa = shard[a][0].f || 1e9, fb = shard[b][0].f || 1e9;
      return fa - fb || (a < b ? -1 : 1);
    });
    const top = matches.slice(0, 12);
    if (!top.length) { hideSuggest(); return; }
    suggWords = top.map((k) => shard[k][0].w);
    suggIdx = -1;
    suggestEl.innerHTML = top.map((k) => {
      const e = shard[k][0];
      const snip = (e.t || '').split('\n')[0].slice(0, 28);
      return `<div class="s-item" data-w="${esc(e.w)}"><span class="s-w">${esc(e.w)}</span><span class="s-t">${esc(snip)}</span></div>`;
    }).join('');
    suggestEl.hidden = false;
    suggestEl.querySelectorAll('.s-item').forEach((it) => it.addEventListener('click', () => lookup(it.dataset.w)));
  }
  function hideSuggest() { suggestEl.hidden = true; suggIdx = -1; }
  function moveSuggest(d) {
    const items = suggestEl.querySelectorAll('.s-item');
    if (!items.length) return;
    suggIdx = (suggIdx + d + items.length) % items.length;
    items.forEach((it, i) => it.classList.toggle('active', i === suggIdx));
    items[suggIdx].scrollIntoView({ block: 'nearest' });
  }

  // ---------- 收藏 / 历史（云端同步） ----------
  async function api(action, payload) {
    try {
      const r = await fetch('/api/wordbook', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ action }, payload || {})),
      });
      return r.ok ? await r.json() : null;
    } catch { return null; }
  }

  function toggleFav(word, head) {
    const on = favMap.has(word);
    const btn = $('favbtn');
    if (on) {
      favMap.delete(word);
      if (btn) { btn.classList.remove('on'); btn.textContent = '☆'; }
      api('unfav', { word });
      toast('已移出单词本');
    } else {
      const snip = (head.t || '').split('\n').slice(0, 2).join(' ').slice(0, 80);
      favMap.set(word, { p: head.p || '', t: snip, created_at: Date.now() });
      if (btn) { btn.classList.add('on'); btn.textContent = '★'; }
      api('fav', { word, p: head.p || '', t: snip });
      toast('已加入单词本 ★');
    }
    updateCounts();
    renderFavList();
  }

  function recordHistory(word) {
    history = history.filter((h) => h.word !== word);
    history.unshift({ word, created_at: Date.now() });
    if (history.length > 200) history.pop();
    updateCounts();
    renderHistList();
    api('hist', { word });
  }

  // ---------- 列表渲染 ----------
  function fmtTime(ts) {
    const d = new Date(ts), p = (x) => String(x).padStart(2, '0');
    const today = new Date();
    if (d.toDateString() === today.toDateString()) return `${p(d.getHours())}:${p(d.getMinutes())}`;
    return `${d.getMonth() + 1}-${p(d.getDate())}`;
  }
  function updateCounts() {
    $('hcnt').textContent = history.length ? `(${history.length})` : '';
    $('fcnt').textContent = favMap.size ? `(${favMap.size})` : '';
  }
  function renderHistList() {
    const wrap = $('histlist'), empty = $('histempty');
    if (!history.length) { wrap.innerHTML = ''; empty.hidden = false; return; }
    empty.hidden = true;
    wrap.innerHTML = history.map((h) =>
      `<div class="litem" data-w="${esc(h.word)}"><span class="lw">${esc(h.word)}</span>`
      + `<span class="lt"></span><span class="ltime">${fmtTime(h.created_at)}</span></div>`).join('');
    wrap.querySelectorAll('.litem').forEach((it) => it.addEventListener('click', () => lookup(it.dataset.w)));
  }
  function renderFavList() {
    const wrap = $('favlist'), empty = $('favempty');
    if (!favMap.size) { wrap.innerHTML = ''; empty.hidden = false; return; }
    empty.hidden = true;
    const arr = [...favMap.entries()].sort((a, b) => b[1].created_at - a[1].created_at);
    wrap.innerHTML = arr.map(([w, v]) =>
      `<div class="litem" data-w="${esc(w)}"><span class="lw">${esc(w)}</span>`
      + `<span class="lp">${v.p ? '/' + esc(v.p) + '/' : ''}</span>`
      + `<span class="lt">${esc(v.t || '')}</span>`
      + `<button class="rm" data-rm="${esc(w)}" title="移出单词本">×</button></div>`).join('');
    wrap.querySelectorAll('.litem').forEach((it) => it.addEventListener('click', (e) => {
      if (e.target.closest('.rm')) return; lookup(it.dataset.w);
    }));
    wrap.querySelectorAll('.rm').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation(); const w = b.dataset.rm;
      favMap.delete(w); api('unfav', { word: w }); updateCounts(); renderFavList();
      if (curWord === w) { const fb = $('favbtn'); if (fb) { fb.classList.remove('on'); fb.textContent = '☆'; } }
    }));
  }

  // ---------- AI ----------
  function renderMd(md) {
    const lines = esc(md).split('\n');
    let html = '', inList = false;
    const inline = (s) => s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>');
    for (let ln of lines) {
      ln = ln.replace(/\s+$/, '');
      if (/^#{1,6}\s+/.test(ln)) { if (inList) { html += '</ul>'; inList = false; } html += `<h2>${inline(ln.replace(/^#{1,6}\s+/, ''))}</h2>`; }
      else if (/^\s*[-*]\s+/.test(ln)) { if (!inList) { html += '<ul>'; inList = true; } html += `<li>${inline(ln.replace(/^\s*[-*]\s+/, ''))}</li>`; }
      else if (/^\s*\d+\.\s+/.test(ln)) { if (!inList) { html += '<ul>'; inList = true; } html += `<li>${inline(ln.replace(/^\s*\d+\.\s+/, ''))}</li>`; }
      else if (ln.trim() === '') { if (inList) { html += '</ul>'; inList = false; } }
      else { if (inList) { html += '</ul>'; inList = false; } html += `<p>${inline(ln)}</p>`; }
    }
    if (inList) html += '</ul>';
    return html;
  }
  function showAI(md) { const p = $('aipanel'); if (p) { p.innerHTML = renderMd(md); p.hidden = false; } }
  async function runAI(word, head) {
    const btn = $('aibtn'), panel = $('aipanel');
    if (aiCache.has(word)) { showAI(aiCache.get(word)); return; }
    btn.disabled = true; btn.innerHTML = '<span class="spin"></span> 分析中…';
    panel.hidden = false; panel.innerHTML = '<p style="color:var(--muted)">AI 正在分析这个单词…</p>';
    try {
      const r = await fetch('/api/dict-ai', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ word, phonetic: head.p || '', translation: (head.t || '').slice(0, 600) }),
      });
      const d = await r.json();
      if (r.ok && d.analysis) { aiCache.set(word, d.analysis); showAI(d.analysis); }
      else { panel.innerHTML = `<p style="color:var(--danger)">${esc(d.error || 'AI 分析失败')}</p>`; }
    } catch { panel.innerHTML = '<p style="color:var(--danger)">网络错误，请稍后再试</p>'; }
    finally { btn.disabled = false; btn.innerHTML = '✨ AI 深度解析'; }
  }

  // ---------- 选项卡 ----------
  function switchTab(name) {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    $('panel-result').hidden = name !== 'result';
    $('panel-history').hidden = name !== 'history';
    $('panel-wordbook').hidden = name !== 'wordbook';
  }
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));

  // ---------- 事件绑定 ----------
  let debTimer = null;
  qEl.addEventListener('input', () => { clearTimeout(debTimer); debTimer = setTimeout(updateSuggest, 110); });
  qEl.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); moveSuggest(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveSuggest(-1); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (suggIdx >= 0 && suggWords[suggIdx]) lookup(suggWords[suggIdx]);
      else lookup(qEl.value);
    } else if (e.key === 'Escape') hideSuggest();
  });
  goEl.addEventListener('click', () => lookup(qEl.value));
  clearqEl.addEventListener('click', () => { qEl.value = ''; clearqEl.hidden = true; hideSuggest(); qEl.focus(); });
  document.addEventListener('click', (e) => { if (!e.target.closest('.search-box')) hideSuggest(); });
  $('clrhist').addEventListener('click', async () => {
    if (!history.length || !confirm('清空全部查词历史？')) return;
    history = []; updateCounts(); renderHistList(); await api('clearhist');
  });

  // quick chips
  const QUICK = ['serendipity', 'comprehensive', 'ubiquitous', 'resilience', 'paradigm', 'meticulous', 'nevertheless', 'ambiguous'];
  $('quick').innerHTML = QUICK.map((w) => `<span class="qc" data-w="${w}">${w}</span>`).join('');
  $('quick').querySelectorAll('.qc').forEach((c) => c.addEventListener('click', () => lookup(c.dataset.w)));

  // hash 路由
  let suppressHash = false;
  window.addEventListener('hashchange', () => {
    if (suppressHash) { suppressHash = false; return; }
    const w = decodeURIComponent(location.hash.slice(1));
    if (w && w !== curWord) lookup(w);
  });

  // ---------- 启动 ----------
  (async function init() {
    try {
      const r = await fetch('/api/wordbook', { headers: { 'Accept': 'application/json' } });
      if (r.ok) {
        const d = await r.json();
        (d.favorites || []).forEach((f) => favMap.set(f.word, { p: f.p, t: f.t, created_at: f.created_at }));
        history = (d.history || []).map((h) => ({ word: h.word, created_at: h.created_at }));
      }
    } catch {}
    updateCounts(); renderHistList(); renderFavList();
    // 预载词库统计 -> 副标题
    try {
      const s = await (await fetch('/dict/_stat.json')).json();
      if (s && s.words) $('sub').textContent = `收录 ${(s.words / 10000).toFixed(0)} 万词 · 牛津/柯林斯星级`;
    } catch {}
    const initW = decodeURIComponent(location.hash.slice(1));
    if (initW) lookup(initW, { noHistory: true });
    else qEl.focus();
  })();

  // 调试钩子
  window.__dict = { lookup, loadShard, bucketFor, state: () => ({ fav: [...favMap.keys()], history, cur: curWord }) };
})();
