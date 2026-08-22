// AI 文本检测 · 引擎 A：统计特征（纯前端，不联网，毫秒级）
//
// 这一档不碰模型，只数文本自身的形状。它的价值是**可解释**：每一条指标都能
// 指着原文说「这里」，而不是甩一个黑箱概率。缺点也得说清楚——
//
//   ⚠ 这是启发式，阈值是手调的，没有在标注语料上校准过。
//     它测的是「AI 味」（文风均匀、套话多、结构规整），不是「AI 生成」。
//     一个写惯了公文/论文的人分数会偏高；一段被人精修过的 AI 文本分数会偏低。
//     任何一档都不该单独当证据用，这也是页面上要并排摆三档引擎的原因。
//
// 为什么不直接算困惑度：那需要语言模型的逐 token logprob。Workers AI 的输出
// schema 只有 response/usage/tool_calls，不给 logprob，所以真困惑度那一档
// （Fast-DetectGPT 曲率）只能放浏览器里用 ONNX 小模型跑，见引擎 C。
(function () {
  // ===== 词表 =====
  // 套话：挑的是「LLM 明显偏爱、人类日常写作里密度低得多」的表达。
  // 像「首先/其次/因此」这种正常汉语高频连接词不放这儿，它们进 CONNECTIVE，
  // 权重更低——不然一篇结构清楚的人类论文会被判成 AI。
  const CLICHE_ZH = [
    '值得注意的是', '需要注意的是', '需要强调的是', '值得一提的是', '需要指出的是',
    '综上所述', '总而言之', '总的来说', '由此可见', '不难看出', '换句话说', '换言之',
    '在当今社会', '在当今时代',
    '至关重要', '具有重要意义', '起到了重要作用', '发挥着重要作用',
    '深入探讨', '全方位', '多维度', '多层面',
    '让我们一起', '希望以上', '以下是一些', '首先我们需要', '接下来我们',
    '不仅如此', '与此同时', '归根结底',
  ];
  // 从这张表里挪走的：「随着…的发展」「进一步提升/优化」下面的 SYNTAX 用正则覆盖得更全，
  // 两张表都留着会把同一处文字算两遍，白白抬高分数。
  // 故意**不**收进词表的几个，都是踩过的误报：
  //   闭环 → 命中「闭环系统」（控制论标准术语）
  //   旨在 / 在一定程度上 / 深入分析 / 不可忽视 → 中文学术写作的常规措辞
  //   赋能 / 助力 / 打造 / 抓手 / 底层逻辑 → 是互联网黑话，人写的 PR 稿一样满篇，
  //     它区分的是「语体」不是「作者是不是模型」，收进来只会误伤
  const CLICHE_EN = [
    'delve into', 'tapestry', 'it is important to note', "it's worth noting",
    'in conclusion', 'navigate the', 'the realm of', 'a testament to', 'underscores',
    'pivotal', 'crucial role', 'a wide range of', 'leverage', 'robust', 'seamless',
    'holistic', 'game-changer', 'embark on', 'shed light on', "in today's",
    'unlock the', 'foster a', 'cutting-edge', 'ever-evolving', 'multifaceted',
  ];
  const CONNECTIVE_ZH = [
    '首先', '其次', '再次', '然后', '最后', '此外', '另外', '而且', '并且',
    '然而', '但是', '因此', '所以', '于是', '同时', '总之', '综上', '不过',
    '因而', '故而', '进而', '从而', '其中', '例如', '比如',
  ];
  const CONNECTIVE_EN = [
    'however', 'therefore', 'moreover', 'furthermore', 'additionally',
    'consequently', 'thus', 'hence', 'meanwhile', 'in addition', 'overall',
    'firstly', 'secondly', 'finally', 'for instance', 'for example',
  ];
  // ===== AI 句式套路 =====
  // 词是点，句式是面。一个词出现一两次能混过去，但句式决定的是节奏，而模型的节奏
  // 跟人对不上——这一档抓的就是节奏。分七类，前两类是「对举排比」（听起来两边都
  // 照顾到了，其实没给出真正的判断），后五类是公文体里模型最容易上瘾的结构。
  //
  // **重要：判的是密度不是有无。** 这些句式人也在用，「不是…而是…」本身没毛病；
  // 问题在于模型没想清楚的时候最容易拿它们来凑气势，于是扎堆出现。所以计分走
  // 每千词命中数，并且把命中的原文摘出来给用户自己看，而不是命中一次就定罪。
  const SYNTAX = [
    { name: '不是…而是',   re: /不是[^，。；！？、\n]{1,24}[，,]\s*而是/g,                                  why: '两边都照顾到，但没说出真正的判断' },
    { name: '不仅…更/还',  re: /不仅[^，。；！？、\n]{0,24}[，,]\s*(?:更|还|也|而且)/g,                     why: '递进式凑气势，删掉后半句意思通常还在' },
    { name: '既要…也要',   re: /既要[^，。；！？、\n]{1,24}[，,]\s*(?:也要|又要|还要)/g,                    why: '面面俱到＝没有取舍' },
    { name: '既…又…',      re: /既[^，。；！？、\n]{2,20}[，,]\s*又[^，。；！？、\n]{2,20}/g,               why: '同上，对举句式' },
    { name: '从…到…',      re: /从[^，。；！？、\n]{1,16}到[^，。；！？、\n]{1,16}[，。；]/g,                why: '铺排范围，常用来充篇幅' },
    { name: '开场三件套',  re: /(?:在[^，。；！？\n]{2,20}的(?:大)?背景下|面对[^，。；！？\n]{2,20}的新形势|根据[^，。；！？\n]{2,20}的(?:统一)?部署|随着[^，。；！？\n]{2,24}的(?:不断|持续|快速)?(?:发展|推进|深入|提升|普及))/g,
      why: '先铺垫背景再进正题——模型不确定从哪儿开口才「安全」' },
    { name: '万能定性句',  re: /(?:是一项系统(?:性)?工程|是一个系统(?:性)?工程|涉及方方面面|具有多重意义|意义重大而深远)/g,
      why: '换成任何主题都成立，等于没传递信息' },
    { name: '推进家族',    re: /(?:进一步|持续|不断|深入|扎实|稳步|统筹|加快|全面|协调|大力|积极|切实)(?:加强|深化|推进|提升|优化|完善|落实|强化|拓展|巩固)/g,
      why: '每个动词前面都配个副词，全都强调＝全都没强调' },
    { name: '以…为…',      re: /以[^，。；！？、\n]{1,14}为(?:引领|导向|抓手|支撑|保障|底线|核心|基础|重点|依托|契机|主线|遵循|根本)/g,
      why: '太好用所以上瘾，一段里能套三四个' },
    { name: '数据报幕',    re: /(?:据统计|数据显示|从数据来看|统计数据表明|有数据表明)/g,                    why: '数据前面要报幕' },
    { name: '数据谢幕',    re: /(?:这一数据充分说明|这充分说明|这一数字背后|充分体现了|这一数据表明)/g,      why: '数据后面还要谢幕，怕读者看不懂' },
    { name: '比喻复读机',  re: /(?:压舱石|助推器|定盘星|风向标|组合拳|先手棋|新引擎|新动能|试金石|催化剂|加速器|稳定器|突破口)/g,
      why: '把比喻当成文体特征，一篇里扎堆用' },
  ];

  // 口语/情绪痕迹：出现得多说明是人在说话，反过来压 AI 分
  const HUMAN_MARK = /[!！?？]|……|\.\.\.|[（(](?:笑|汗|捂脸|狗头)[)）]|哈哈|嘛|呗|啦|吧了|233|orz/;

  const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
  // 把一个指标线性映到 0..1 的「AI 味」。lo 对应 0、hi 对应 1，方向由两者大小决定。
  const ramp = (v, lo, hi) => clamp01((v - lo) / (hi - lo));

  // 中文按字、西文按词计长度：两种文字混排时才不会一边倒
  function tokenCount(s) {
    const cjk = s.match(/[㐀-鿿豈-﫿]/g);
    const word = s.match(/[A-Za-z][A-Za-z'’-]*/g);
    const num = s.match(/\d+(?:[.,]\d+)*/g);
    return (cjk ? cjk.length : 0) + (word ? word.length : 0) + (num ? num.length : 0);
  }

  function stats(arr) {
    const n = arr.length;
    if (!n) return { n: 0, mean: 0, sd: 0, cv: 0 };
    const mean = arr.reduce((a, b) => a + b, 0) / n;
    if (n < 2 || mean <= 0) return { n, mean, sd: 0, cv: 0 };
    const sd = Math.sqrt(arr.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (n - 1));
    return { n, mean, sd, cv: sd / mean };
  }

  // 断句：中文标点直接断，英文句号要排除小数点和 e.g. 这类缩写
  function splitSentences(text) {
    const out = [];
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      const next = text[i + 1] || '';
      let end = false;
      if ('。！？；!?…\n'.indexOf(ch) >= 0) end = true;
      else if (ch === '.' && /[\s\n]/.test(next) && !/\d/.test(text[i - 1] || '')) end = true;
      if (!end) continue;
      // 把紧跟其后的收尾引号/括号一起吃掉，别把 」 甩到下一句开头
      while (i + 1 < text.length && /[”’』」）)"']/.test(text[i + 1])) i++;
      const raw = text.slice(start, i + 1);
      if (raw.trim().length >= 2) out.push({ text: raw.trim(), start, end: i + 1 });
      start = i + 1;
    }
    const tail = text.slice(start);
    if (tail.trim().length >= 2) out.push({ text: tail.trim(), start, end: text.length });
    return out;
  }

  // 扫句式套路。回传总命中数、按类别聚合的明细（含原文片段），以及命中位置区间
  // ——位置给逐句热力用，让「哪一句踩了哪个套路」能直接指出来。
  function scanSyntax(text) {
    let total = 0;
    const groups = [];
    const spans = [];
    for (const p of SYNTAX) {
      p.re.lastIndex = 0;
      let m;
      const samples = [];
      let n = 0;
      while ((m = p.re.exec(text)) !== null) {
        if (m[0].length === 0) { p.re.lastIndex++; continue; }   // 防零宽匹配死循环
        n++;
        spans.push({ start: m.index, end: m.index + m[0].length, name: p.name });
        if (samples.length < 3) samples.push(m[0].length > 26 ? m[0].slice(0, 26) + '…' : m[0]);
      }
      if (n) { total += n; groups.push({ name: p.name, n, why: p.why, samples }); }
    }
    groups.sort((a, b) => b.n - a.n);
    return { total, groups, spans };
  }

  function countHits(lower, list) {
    let n = 0;
    const hit = [];
    for (const w of list) {
      let from = 0;
      for (;;) {
        const k = lower.indexOf(w, from);
        if (k < 0) break;
        n++;
        if (hit.length < 24 && !hit.includes(w)) hit.push(w);
        from = k + w.length;
      }
    }
    return { n, hit };
  }

  // 重复 4-gram 占比：人写东西会不自觉复读某些短语，AI 反而更「不重样」
  function repeatRate(text) {
    const s = text.replace(/\s+/g, '');
    if (s.length < 40) return 0;
    const seen = new Set();
    let dup = 0, total = 0;
    for (let i = 0; i + 4 <= s.length; i++) {
      const g = s.slice(i, i + 4);
      total++;
      if (seen.has(g)) dup++; else seen.add(g);
    }
    return total ? dup / total : 0;
  }

  // 字符 bigram 的移动平均类符形符比（MATTR）：中文没分词也能算词汇多样性
  function mattr(text, win) {
    const s = text.replace(/\s+/g, '');
    const grams = [];
    for (let i = 0; i + 2 <= s.length; i++) grams.push(s.slice(i, i + 2));
    if (grams.length <= win) {
      return grams.length ? new Set(grams).size / grams.length : 0;
    }
    let sum = 0, k = 0;
    for (let i = 0; i + win <= grams.length; i += Math.max(1, Math.floor(win / 4))) {
      sum += new Set(grams.slice(i, i + win)).size / win;
      k++;
    }
    return k ? sum / k : 0;
  }

  function analyze(input) {
    const text = String(input || '');
    const total = tokenCount(text);
    const lower = text.toLowerCase();

    const cjk = (text.match(/[一-鿿]/g) || []).length;
    const latin = (text.match(/[A-Za-z]/g) || []).length;
    const cjkRatio = cjk + latin ? cjk / (cjk + latin) : 0;
    const lang = cjkRatio > 0.7 ? 'zh' : cjkRatio < 0.15 ? 'en' : 'mix';

    const sentences = splitSentences(text);
    const paragraphs = text.split(/\n\s*\n|\n(?=\s*[#>\-*\d])/).map((p) => p.trim()).filter((p) => tokenCount(p) >= 6);

    if (total < 40 || sentences.length < 3) {
      return { ok: false, reason: '文本太短，统计特征不成立（建议至少 100 字 / 5 句）', chars: text.length, tokens: total, lang, sentences: [], metrics: [], score: null };
    }

    const sentLens = sentences.map((s) => tokenCount(s.text)).filter((n) => n > 0);
    const sLen = stats(sentLens);
    const pLen = stats(paragraphs.map(tokenCount));

    const cliche = countHits(lower, lang === 'en' ? CLICHE_EN : CLICHE_ZH.concat(CLICHE_EN));
    const conn = countHits(lower, lang === 'en' ? CONNECTIVE_EN : CONNECTIVE_ZH.concat(CONNECTIVE_EN));
    const per1k = (n) => (total ? (n / total) * 1000 : 0);

    // 人类痕迹：带感叹/疑问/省略号/口语词的句子占比
    const humanSent = sentences.filter((s) => HUMAN_MARK.test(s.text)).length / sentences.length;
    // 结构标记：编号、项目符号、加粗、标题
    const structure = (text.match(/^\s*(?:[-*·•]|\d+[.、)）]|#{1,6}\s)/gm) || []).length
      + (text.match(/\*\*[^*\n]{1,40}\*\*/g) || []).length;
    const structPerPara = paragraphs.length ? structure / paragraphs.length : 0;

    const rep = repeatRate(text);
    const div = mattr(text, 100);

    const syn = scanSyntax(text);

    // 每条：value 原始值、ainess 0..1、weight 权重。阈值全是手调的经验值，注释里写明方向。
    const metrics = [
      {
        // **不进加权平均，只作加分项**（weight: 0，下面单独算 bonus / floor）。
        // 原因是这条证据是不对称的：命中＝强证据（人写不出一段连堆五类套路的节奏），
        // 但没命中**不是**人写的证据——大量 AI 论述文根本不用排比句式。
        // 一开始把它按 0.24 的权重塞进加权平均，结果一段明显的 AI 论述文只中 1 处，
        // 反倒把总分从 80 稀释到 69。加分项才符合它的证据性质。
        key: 'syntax', name: 'AI 句式套路', weight: 0, bonus: true,
        value: per1k(syn.total), display: syn.total + ' 处 · ' + per1k(syn.total).toFixed(1) + '/千词',
        ainess: ramp(per1k(syn.total), 0, 14),
        note: syn.groups.length
          ? syn.groups.map((g) => `${g.name}×${g.n}`).join('、')
          : '没踩到任何一类套路句式。',
        groups: syn.groups,
      },
      {
        key: 'burst', name: '句长突发度', weight: 0.24,
        value: sLen.cv, display: sLen.cv.toFixed(2),
        // 人写句子忽长忽短，变异系数常在 .45~.80；模型输出普遍更齐整
        ainess: ramp(sLen.cv, 0.70, 0.25),
        note: `平均 ${sLen.mean.toFixed(0)} 词/句，标准差 ${sLen.sd.toFixed(1)}。越接近 0 说明每句长得越像。`,
      },
      {
        key: 'para', name: '段落齐整度', weight: 0.10,
        value: pLen.cv, display: pLen.cv ? pLen.cv.toFixed(2) : '—',
        ainess: pLen.n >= 3 ? ramp(pLen.cv, 0.60, 0.15) : 0.5,
        note: pLen.n >= 3 ? `${pLen.n} 段，平均 ${pLen.mean.toFixed(0)} 词。模型爱把每段写成差不多长。` : '段落太少，此项按中性计。',
      },
      {
        key: 'cliche', name: '套话密度', weight: 0.24,
        value: per1k(cliche.n), display: per1k(cliche.n).toFixed(1) + '/千词',
        ainess: ramp(per1k(cliche.n), 0, 12),
        note: cliche.hit.length ? '命中：' + cliche.hit.slice(0, 10).join('、') : '没命中词表里的 AI 常用套话。',
      },
      {
        key: 'conn', name: '连接词密度', weight: 0.13,
        value: per1k(conn.n), display: per1k(conn.n).toFixed(1) + '/千词',
        ainess: ramp(per1k(conn.n), 8, 40),
        note: '「首先/其次/因此/然而」这类。模型爱把逻辑显式铺满，人写常靠语序带过。',
      },
      {
        key: 'human', name: '口语与情绪痕迹', weight: 0.13,
        value: humanSent, display: (humanSent * 100).toFixed(0) + '%',
        // 方向相反：痕迹越少越像 AI。论文/公文天然是 0，所以权重压低，
        // 另外靠下面的 register 提示单独说明，别让它一条把正式文体拖进 AI 区。
        ainess: ramp(humanSent, 0.30, 0.02),
        note: '带感叹号、疑问、省略号或口语词的句子占比。模型的默认语气很少这样，但论文/公文同样如此。',
      },
      {
        key: 'repeat', name: '自我复读率', weight: 0.05,
        value: rep, display: (rep * 100).toFixed(1) + '%',
        // 上限原来写的 0.22，是拍脑袋拍错了：几百词的短文本 4-gram 重复率实测就在
        // 0~8% 之间，22% 那档谁都够不着，结果这条指标对所有样本一律输出 100%（等于没有）。
        ainess: ramp(rep, 0.06, 0.005),
        note: '重复四字片段的比例。人会不自觉复读，模型输出反而更「不重样」。文本越短这条越不可靠，所以权重最低。',
      },
      {
        key: 'struct', name: '结构规整度', weight: 0.11,
        value: structPerPara, display: structPerPara.toFixed(2) + '/段',
        ainess: ramp(structPerPara, 0.05, 1.2),
        note: '编号、项目符号、加粗、小标题的密度。模型爱排比着列。',
      },
    ];

    let score = 0, wsum = 0;
    for (const m of metrics) {
      if (m.bonus) continue;                       // 加分项不进加权平均
      score += m.ainess * m.weight; wsum += m.weight;
    }
    score = Math.round((score / wsum) * 100);

    // 句式套路单独结算：命中越密加得越多（封顶 +30），密到一定程度再压一条下限。
    // 下限是为了兜住「句式全中但其它指标不极端」的公文体——实测那种文本加权和只有 60，
    // 而它 10 类套路全踩，17 处命中，判成「偏 AI」明显过轻。
    const synPer1k = per1k(syn.total);
    const synBonus = Math.min(30, Math.round(syn.total * 2.5 + synPer1k * 0.2));
    const synFloor = (syn.total >= 8 && synPer1k >= 30) ? 78
      : (syn.total >= 4 && synPer1k >= 15) ? 66
        : 0;
    score = Math.min(100, score + synBonus);
    if (synFloor > score) score = synFloor;

    // 词汇多样性只作为旁证展示，不进总分（它对文体和长度太敏感）
    const aside = { key: 'div', name: '词汇多样性', display: div.toFixed(3), note: '字符 bigram 的移动平均类符形符比，仅供参考，不计入总分。' };

    // 逐句热力：跟总分是两套算法，用途不同——总分看全局形状，热力指哪句最可疑
    const meanLen = sLen.mean;
    for (const s of sentences) {
      const low = s.text.toLowerCase();
      let v = 0;
      const why = [];
      // 句式套路命中这一句就直接顶上去——它比套话更能说明问题，所以给的分也更重
      const hitsHere = syn.spans.filter((sp) => sp.start >= s.start && sp.start < s.end);
      if (hitsHere.length) {
        v += Math.min(0.55, hitsHere.length * 0.34);
        why.push('句式：' + [...new Set(hitsHere.map((h) => h.name))].join('、'));
      }
      const c = countHits(low, lang === 'en' ? CLICHE_EN : CLICHE_ZH.concat(CLICHE_EN));
      if (c.n) { v += Math.min(0.42, c.n * 0.24); why.push('套话：' + c.hit.slice(0, 3).join('、')); }
      const startsConn = (lang === 'en' ? CONNECTIVE_EN : CONNECTIVE_ZH).some((w) => low.startsWith(w));
      if (startsConn) { v += 0.18; why.push('以连接词开头'); }
      const len = tokenCount(s.text);
      if (meanLen > 0 && Math.abs(len - meanLen) / meanLen < 0.15) { v += 0.16; why.push('长度贴着全文均值'); }
      if (/^\s*(?:[-*·•]|\d+[.、)）])/.test(s.text)) { v += 0.14; why.push('列举式结构'); }
      if (HUMAN_MARK.test(s.text)) { v -= 0.30; why.push('有口语/情绪痕迹（压分）'); }
      s.score = clamp01(v);
      s.why = why;
    }

    // 语体提示：正式书面语（论文/公文/说明书）本来就句长齐整、不带情绪、爱用连接词，
    // 这几条正好是本引擎判 AI 的主要依据 —— 会系统性地把这类人写文本推高。
    // 与其偷偷调权重把它压下去（那会连真 AI 一起放过），不如明说：这一档在此类文本上
    // 判别力弱，请以引擎 B 为准。这也是任何基于突发度的检测器共同的失效模式。
    // 套话密度这一项必须同时**低**才算数：AI 文本本来也「正式」，只看句长齐整+没情绪词
    // 的话这条提示对着一篇满是「综上所述/值得注意的是」的模型输出照样弹，等于替它开脱。
    // 套话高 = 有 AI 独有的证据，那就不是单纯的语体问题了。
    const formal = humanSent < 0.05 && sLen.cv < 0.42 && per1k(conn.n) > 6 && per1k(cliche.n) < 8;
    const register = formal
      ? '这段像是正式书面语体（论文 / 公文 / 技术文档）。这类文本天生句长齐整、不带情绪词，'
        + '统计特征会系统性偏高——分数偏 AI 不代表就是 AI，请结合引擎 B 的判断一起看。'
      : '';

    return {
      ok: true, chars: text.length, tokens: total, lang, cjkRatio,
      sentences, metrics, aside, score, register, syntax: syn,
      confidence: total < 120 ? 'low' : total < 400 ? 'mid' : 'high',
      band: band(score),
    };
  }

  function band(s) {
    if (s < 25) return { key: 'human', label: '更像人写' };
    if (s < 45) return { key: 'lean-human', label: '偏人写' };
    if (s < 60) return { key: 'unsure', label: '说不好' };
    if (s < 78) return { key: 'lean-ai', label: '偏 AI' };
    return { key: 'ai', label: '更像 AI 生成' };
  }

  window.NBTextStats = { analyze, splitSentences, tokenCount, band };
})();
