// 极简、安全的 Markdown 渲染：先转义 HTML，再识别常见块/行内语法。
// 暴露 window.renderMarkdown(text) -> 安全的 HTML 字符串。供 AI 对话气泡使用。
(function () {
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  // 行内：在「已转义」文本上做标记替换
  function inline(s) {
    let t = esc(s);
    t = t.replace(/`([^`]+)`/g, (m, c) => `<code>${c}</code>`);
    t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, txt, url) => {
      const safe = /^https?:\/\//i.test(url) ? url : '#';
      return `<a href="${safe}" target="_blank" rel="noopener noreferrer">${txt}</a>`;
    });
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    t = t.replace(/(^|[^_\w])_([^_\n]+)_/g, '$1<em>$2</em>');
    return t;
  }

  const isBlockStart = (l) =>
    /^(#{1,6}\s|>|```|\s*[-*+]\s|\s*\d+[.)]\s)/.test(l) || /^\s*([-*_])\1{2,}\s*$/.test(l);

  function render(src) {
    const lines = String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n');
    let html = '';
    let listType = null;
    let i = 0;
    const closeList = () => { if (listType) { html += `</${listType}>`; listType = null; } };

    while (i < lines.length) {
      const line = lines[i];

      const fence = line.match(/^```(.*)$/);
      if (fence) {
        closeList();
        i++;
        let code = '';
        while (i < lines.length && !/^```/.test(lines[i])) { code += lines[i] + '\n'; i++; }
        i++;
        html += `<pre><code>${esc(code.replace(/\n$/, ''))}</code></pre>`;
        continue;
      }

      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) { closeList(); html += `<${h[1].length <= 2 ? 'h4' : 'h5'}>${inline(h[2])}</${h[1].length <= 2 ? 'h4' : 'h5'}>`; i++; continue; }

      if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { closeList(); html += '<hr>'; i++; continue; }

      if (/^>\s?/.test(line)) { closeList(); html += `<blockquote>${inline(line.replace(/^>\s?/, ''))}</blockquote>`; i++; continue; }

      const ul = line.match(/^\s*[-*+]\s+(.*)$/);
      const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (ul || ol) {
        const t = ul ? 'ul' : 'ol';
        if (listType && listType !== t) closeList();
        if (!listType) { listType = t; html += `<${t}>`; }
        html += `<li>${inline((ul || ol)[1])}</li>`;
        i++;
        continue;
      }

      if (/^\s*$/.test(line)) { closeList(); i++; continue; }

      // 普通段落：合并相邻非块行
      closeList();
      let para = line;
      i++;
      while (i < lines.length && !/^\s*$/.test(lines[i]) && !isBlockStart(lines[i])) {
        para += '\n' + lines[i];
        i++;
      }
      html += `<p>${inline(para).replace(/\n/g, '<br>')}</p>`;
    }
    closeList();
    return html;
  }

  window.renderMarkdown = render;
})();
