// AI 痕迹实验室 · 文本检测页
//
// 两档引擎并排出结果，谁也不假装自己是终审：
//   A 文风统计（ailab-stats.js，纯本地、毫秒级、每条都能指着原文说理由）
//   B 模型评审（/api/ai-detect，三个大模型各判一次 + 归因，分歧量一起回给用户）
// 两档打架的时候就是「这段不好判」，页面会直说，而不是硬凑一个数字。
(function () {
  const $ = (id) => document.getElementById(id);
  const textEl = $('lab-text');
  const countEl = $('lab-count');
  const msgEl = $('lab-msg');
  const runBtn = $('lab-run');
  const llmBox = $('lab-usellm');
  const resultEl = $('lab-result');

  const CDN_JSZIP = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';
  const CDN_PDFJS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.min.mjs';
  const CDN_PDFJS_WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.worker.min.mjs';

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function say(text, kind) {
    if (!text) { msgEl.hidden = true; return; }
    msgEl.hidden = false;
    msgEl.textContent = text;
    msgEl.className = 'lab-msg' + (kind ? ' ' + kind : '');
  }

  // ===== 输入 =====
  function updateCount() {
    const t = textEl.value;
    const n = window.NBTextStats ? window.NBTextStats.tokenCount(t) : t.length;
    countEl.textContent = t ? `${t.length} 字符 · 约 ${n} 词` : '';
    runBtn.disabled = t.trim().length < 20;
  }
  textEl.addEventListener('input', updateCount);

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) return resolve();
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('脚本加载失败：' + src));
      document.head.appendChild(s);
    });
  }

  // docx 只要正文，不必上 docx-preview 那套渲染器：解压出 word/document.xml，
  // 把 <w:p> 换成换行、剩下的标签全剥掉就够了。
  async function readDocx(file) {
    await loadScript(CDN_JSZIP);
    const zip = await window.JSZip.loadAsync(await file.arrayBuffer());
    const entry = zip.file('word/document.xml');
    if (!entry) throw new Error('这个 .docx 里没找到正文');
    const xml = await entry.async('string');
    return xml
      .replace(/<w:p[ >]/g, '\n<w:p ')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<w:tab\/>/g, '\t')
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  async function readPdf(file) {
    const pdfjs = await import(CDN_PDFJS);
    pdfjs.GlobalWorkerOptions.workerSrc = CDN_PDFJS_WORKER;
    const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
    const pages = [];
    // 检测只需要够用的样本量，整本几百页没必要全抽
    const n = Math.min(doc.numPages, 20);
    for (let i = 1; i <= n; i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      pages.push(tc.items.map((it) => it.str).join(''));
    }
    if (doc.numPages > n) pages.push(`\n（只取了前 ${n} 页，共 ${doc.numPages} 页）`);
    return pages.join('\n\n').trim();
  }

  async function ingest(file) {
    const name = (file.name || '').toLowerCase();
    say(`正在读取 ${file.name}…`);
    try {
      let text;
      if (name.endsWith('.docx')) text = await readDocx(file);
      else if (name.endsWith('.pdf')) text = await readPdf(file);
      else if (/\.(txt|md|markdown|csv|json|log|srt)$/.test(name) || file.type.startsWith('text/')) text = await file.text();
      else throw new Error('只认 .txt / .md / .docx / .pdf（旧版 .doc 没有可靠的纯前端解析库）');
      if (!text.trim()) throw new Error('没读到文字内容（扫描版 PDF 是图片，需要 OCR）');
      textEl.value = text;
      updateCount();
      say(`已读入 ${file.name}，${text.length} 字符`, 'ok');
    } catch (e) {
      say(e.message || '读取失败', 'err');
    }
  }

  $('lab-file').addEventListener('click', () => $('lab-fileinput').click());
  $('lab-fileinput').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (f) ingest(f);
  });

  const drop = $('lab-drop');
  ['dragenter', 'dragover'].forEach((k) => drop.addEventListener(k, (e) => {
    e.preventDefault();
    drop.classList.add('over');
  }));
  ['dragleave', 'drop'].forEach((k) => drop.addEventListener(k, (e) => {
    e.preventDefault();
    if (k === 'dragleave' && drop.contains(e.relatedTarget)) return;
    drop.classList.remove('over');
  }));
  drop.addEventListener('drop', (e) => {
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) ingest(f);
  });

  // ===== 示例：页面自带三份对照样本，自己就是教具 =====
  const SAMPLES = [
    { name: '模型输出', text: `随着人工智能技术的不断发展，大语言模型在各个领域展现出了巨大的潜力。首先，它极大地提升了内容生产的效率，使得原本需要数小时完成的工作可以在几分钟内完成。其次，它降低了专业知识的获取门槛，让普通用户也能够快速理解复杂的概念。\n\n然而，我们也需要注意到其中存在的问题。值得注意的是，模型输出的内容可能存在事实性错误，这在专业领域尤其危险。此外，过度依赖工具可能会削弱人们独立思考的能力，这一点至关重要。\n\n综上所述，人工智能既是机遇也是挑战。我们应当以开放的心态拥抱技术，同时保持批判性思维。总的来说，只有在充分理解其边界的前提下，才能真正发挥它的价值。` },
    { name: '人写 · 随笔', text: `昨天调那个破工具栏调到凌晨两点。\n\n问题出在哪呢？我一开始以为是 CSS 的锅，把 order 翻来覆去改了七八遍，没用。后来才反应过来——iOS 弹键盘的时候 dvh 根本不缩！\n\n真是服了。visualViewport 这个 API 我以前压根没听说过，还是翻 StackOverflow 才翻到的。加了三行代码就好了。三行！\n\n所以说啊，有时候折腾半天不是你不会写，是你不知道有这么个东西存在。` },
    { name: '人写 · 论文段', text: `本文研究半潜式水下机器人在波浪扰动下的姿态稳定问题。首先建立六自由度动力学模型，考虑附加质量、粘性阻尼与恢复力矩三部分作用。其次，针对模型参数存在不确定性的情况，设计了自适应滑模控制器，并通过 Lyapunov 方法证明了闭环系统的渐近稳定性。\n\n仿真在 MATLAB/Simulink 平台上进行，海况取三级，有义波高 1.25 米。结果表明，与传统 PID 相比，本文方法在纵摇角超调量上降低了 42%，调节时间缩短约 3.1 秒。\n\n需要指出的是，本文未考虑推进器饱和与执行机构延迟，这将在后续工作中补充。` },
  ];
  let sampleIdx = 0;
  $('lab-sample').addEventListener('click', () => {
    const s = SAMPLES[sampleIdx % SAMPLES.length];
    sampleIdx++;
    textEl.value = s.text;
    updateCount();
    say(`已填入示例：${s.name}（再点一次换下一份）`, 'ok');
  });

  // ===== 跑检测 =====
  let running = false;
  runBtn.addEventListener('click', run);

  async function run() {
    if (running) return;
    const text = textEl.value;
    if (text.trim().length < 20) return;
    running = true;
    runBtn.disabled = true;
    runBtn.textContent = '检测中…';
    say('');

    const stat = window.NBTextStats.analyze(text);
    resultEl.hidden = false;
    renderStats(stat);
    renderHeat(text, stat);

    const wantLLM = llmBox.checked && text.trim().length >= 60;
    $('lab-judges-card').hidden = !wantLLM;
    $('lab-ppl-card').hidden = !wantLLM;
    if (wantLLM) {
      $('lab-judges').innerHTML = '<p class="lab-wait">三个模型正在各自判读，通常 5–15 秒…</p>';
      $('lab-b-score').textContent = '…';
      $('lab-b-label').textContent = '评审中';
      $('lab-ppl-body').innerHTML = '<p class="lab-wait">正在向参照模型逐 token 问概率…</p>';
      $('lab-c-score').textContent = '…';
      $('lab-c-label').textContent = '计算中';
      // 两档互不依赖，一起发；哪档挂了都不影响另一档
      await Promise.all([
        callEngine('/api/ai-detect', { text: text.slice(0, 6000) }, renderJudges, (msg) => {
          $('lab-judges').innerHTML = `<p class="lab-wait err">${esc(msg)}</p>`;
          $('lab-b-score').textContent = '—';
          $('lab-b-label').textContent = '不可用';
        }),
        callEngine('/api/ai-perplexity', { text: text.slice(0, 4000) }, renderPpl, (msg) => {
          $('lab-ppl-body').innerHTML = `<p class="lab-wait err">${esc(msg)}</p>`;
          $('lab-c-score').textContent = '—';
          $('lab-c-label').textContent = '不可用';
        }),
      ]);
    } else if (llmBox.checked) {
      $('lab-judges-card').hidden = false;
      $('lab-judges').innerHTML = '<p class="lab-wait">文本不足 60 字，模型评审跳过了。</p>';
      $('lab-b-score').textContent = '—';
      $('lab-b-label').textContent = '文本太短';
      $('lab-c-score').textContent = '—';
      $('lab-c-label').textContent = '文本太短';
    } else {
      $('lab-b-score').textContent = '—';
      $('lab-b-label').textContent = '未启用';
      $('lab-c-score').textContent = '—';
      $('lab-c-label').textContent = '未启用';
    }

    running = false;
    runBtn.disabled = false;
    runBtn.textContent = '开始检测';
    resultEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ===== 引擎 A 渲染 =====
  function renderStats(r) {
    const scoreEl = $('lab-a-score');
    const labelEl = $('lab-a-label');
    if (!r.ok) {
      scoreEl.textContent = '—';
      labelEl.textContent = '文本太短';
      $('lab-metrics').innerHTML = `<p class="lab-wait">${esc(r.reason)}</p>`;
      $('lab-register').hidden = true;
      return;
    }
    scoreEl.textContent = r.score;
    labelEl.textContent = r.band.label;
    setRing($('lab-a-ring'), r.score);
    $('lab-a-meta').textContent = `${r.tokens} 词 · ${r.sentences.length} 句 · 置信度${
      { low: '低（文本偏短）', mid: '中', high: '高' }[r.confidence]}`;

    $('lab-metrics').innerHTML = r.metrics.map((m) => `
      <div class="mt">
        <div class="mt-top">
          <span class="mt-name">${esc(m.name)}</span>
          <span class="mt-val">${esc(m.display)}</span>
          <!-- 进度条画的是「AI 味」不是左边那个原始值，不把百分比写出来两者容易看串 -->
          <span class="mt-w"><b>AI 味 ${(m.ainess * 100).toFixed(0)}%</b> · 权重 ${(m.weight * 100).toFixed(0)}%</span>
        </div>
        <div class="mt-bar"><i style="width:${(m.ainess * 100).toFixed(1)}%"></i></div>
        <p class="mt-note">${esc(m.note)}</p>
      </div>`).join('')
      + `<p class="mt-aside">${esc(r.aside.name)}：<b>${esc(r.aside.display)}</b> —— ${esc(r.aside.note)}</p>`;

    const reg = $('lab-register');
    reg.hidden = !r.register;
    reg.textContent = r.register || '';
  }

  function setRing(el, score) {
    if (!el) return;
    const C = 2 * Math.PI * 26;
    el.style.strokeDasharray = `${(C * score / 100).toFixed(2)} ${C.toFixed(2)}`;
  }

  async function callEngine(url, body, ok, fail) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'HTTP ' + r.status);
      ok(d);
    } catch (e) {
      fail((e && e.message) || '请求失败');
    }
  }

  // ===== 引擎 C 渲染（GLTR 分桶） =====
  const GL_CLASS = ['gl-b1', 'gl-b2', 'gl-b3', 'gl-b4'];
  const GL_NAME = ['第一选择 (rank 1)', '前 10', '前 100', '更冷门'];

  function renderPpl(d) {
    $('lab-c-score').textContent = d.score;
    $('lab-c-label').textContent = window.NBTextStats.band(d.score).label;
    setRing($('lab-c-ring'), d.score);
    $('lab-c-meta').textContent = `困惑度 ${d.ppl} · ${d.tokens} token`;
    $('lab-ppl-model').textContent = d.model.replace('@cf/', '');

    const b = d.buckets;
    const n = b.top1 + b.top10 + b.top100 + b.rest || 1;
    const parts = [b.top1, b.top10, b.top100, b.rest];
    $('lab-ppl-body').innerHTML = `
      <div class="gl-nums">
        <div class="gl-num"><b>${d.ppl}</b><span>困惑度（越低越像 AI）</span></div>
        <div class="gl-num"><b>${(d.top1 * 100).toFixed(0)}%</b><span>命中模型第一选择</span></div>
        <div class="gl-num"><b>${d.tokens}</b><span>参与计算的 token</span></div>
      </div>
      <div class="gl-stack">${parts.map((v, i) => `<i class="${GL_CLASS[i]}" style="width:${(v / n * 100).toFixed(2)}%"></i>`).join('')}</div>
      <div class="gl-legend">${parts.map((v, i) => `<span><i class="${GL_CLASS[i]}"></i>${GL_NAME[i]} ${(v / n * 100).toFixed(0)}%</span>`).join('')}</div>
      <div class="gl-strip">${(d.marks || []).map((m) => {
        const i = m.rank === 1 ? 0 : m.rank <= 10 ? 1 : m.rank <= 100 ? 2 : 3;
        const label = m.t ? m.t.replace(/\n/g, '\\n') : '(字节片段)';
        return `<i class="${GL_CLASS[i]}" title="${esc(label)} · rank ${m.rank} · logprob ${m.lp}"></i>`;
      }).join('')}</div>
      <p class="gl-note">
        做法出自 <b>GLTR</b>(Gehrmann et al., ACL 2019)：把文本喂给一个参照模型，看它事先能不能猜中每个 token。
        模型写的东西，token 大多正好是参照模型的第一选择（绿色）；人写的会不断冒出它想不到的词（红/紫）。
        <b>三个前提要记住：</b>① 参照模型是 Mistral，出自同族模型的文本会得分更高，别家的会偏低；
        ② 把 AI 文本改写一遍就能骗过它；③ 非母语者和正式文体的困惑度天然偏低，这是这类方法公认的误报来源。
      </p>`;
  }

  // ===== 引擎 B 渲染 =====
  function renderJudges(d) {
    const c = d.consensus || {};
    $('lab-b-score').textContent = c.score == null ? '—' : c.score;
    // 后端在平票时故意留空 verdict —— 别把「没共识」显示成某一方赢了
    $('lab-b-label').textContent = c.verdict || '各执一词';
    setRing($('lab-b-ring'), c.score || 0);
    $('lab-b-meta').textContent = c.agreed
      ? `三位评委分歧 ${c.spread} 分，基本一致`
      : `⚠ 评委分歧 ${c.spread} 分，这段本身就不好判`;
    $('lab-b-meta').className = 'lab-sub' + (c.agreed ? '' : ' warn');

    $('lab-judges').innerHTML = (d.judges || []).map((j) => {
      if (j.score == null) {
        return `<div class="jg jg-bad"><div class="jg-h"><b>${esc(j.label)}</b><span class="jg-s">—</span></div>
          <p class="jg-r">${esc(j.error || '没给出判断')}</p></div>`;
      }
      return `<div class="jg">
        <div class="jg-h"><b>${esc(j.label)}</b><span class="jg-s" data-hot="${j.score >= 60 ? '1' : '0'}">${j.score}</span></div>
        <p class="jg-v">${esc(j.verdict)}</p>
        <ul class="jg-r">${j.reasons.map((x) => `<li>${esc(x)}</li>`).join('') || '<li>没给理由</li>'}</ul>
        ${j.score >= 50 && j.likely && j.likely !== '说不好'
          ? `<p class="jg-l">像 <b>${esc(j.likely)}</b>${j.likelyWhy ? ' · ' + esc(j.likelyWhy) : ''}</p>` : ''}
      </div>`;
    }).join('');

    const attr = $('lab-attr');
    if (c.likely && c.likely !== '说不好') {
      attr.hidden = false;
      attr.innerHTML = `多数评委觉得像 <b>${esc(c.likely)}</b>。`
        + '<span class="lab-caveat">——这是按文风猜的，不是水印或指纹，仅供玩味。各家模型的语料高度重叠，风格归因本来就不可靠。</span>';
    } else {
      attr.hidden = true;
    }
  }

  // ===== 逐句热力 =====
  function renderHeat(text, r) {
    const box = $('lab-heat');
    if (!r.ok || !r.sentences.length) { $('lab-heat-card').hidden = true; return; }
    $('lab-heat-card').hidden = false;
    let html = '';
    let cur = 0;
    for (const s of r.sentences) {
      if (s.start > cur) html += esc(text.slice(cur, s.start));
      const a = (s.score * 0.45).toFixed(3);
      const why = s.why && s.why.length ? s.why.join('；') : '没触发任何可疑特征';
      html += `<span class="hs" style="background:rgba(226,116,58,${a})" title="${esc(why)}" data-score="${(s.score * 100).toFixed(0)}">${esc(text.slice(s.start, s.end))}</span>`;
      cur = s.end;
    }
    if (cur < text.length) html += esc(text.slice(cur));
    box.innerHTML = html;
  }

  updateCount();
})();
