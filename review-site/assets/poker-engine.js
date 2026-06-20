// poker-engine.js — 斗地主纯逻辑引擎（牌型识别 / 比较 / 找牌 / 启发式 AI）
// 单一真相源：notes/poker.html 用 <script type="module"> import，nn-diag 单测也 import。
// 牌：对象 {r, s, id}。r=点数值(3..15=2)，小王 r=16，大王 r=17；s=花色 0♠1♥2♣3♦，王 s='x'/'X'。

export const SUITS = ['♠', '♥', '♣', '♦'];
export const R3 = 3, R2 = 15, BJ = 16, RJ = 17; // 王炸用 BJ/RJ

// 点数标签
export function rankLabel(r) {
  if (r === 16) return 'w';   // 小王
  if (r === 17) return 'W';   // 大王
  if (r === 15) return '2';
  if (r === 14) return 'A';
  if (r === 13) return 'K';
  if (r === 12) return 'Q';
  if (r === 11) return 'J';
  if (r === 10) return '10';
  return String(r);
}
export function isRed(c) { return c.s === 1 || c.s === 3 || c.s === 'X'; }
export function isJoker(c) { return c.r >= 16; }

// 生成 54 张牌
export function makeDeck() {
  const d = [];
  let id = 0;
  for (let r = 3; r <= 15; r++) for (let s = 0; s < 4; s++) d.push({ r, s, id: id++ });
  d.push({ r: 16, s: 'x', id: id++ });
  d.push({ r: 17, s: 'X', id: id++ });
  return d;
}

// 可注入随机数的洗牌（测试可固定种子）
export function shuffle(arr, rng = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
// 简单可重现 RNG
export function mulberry32(seed) {
  let t = seed >>> 0;
  return function () {
    t += 0x6D2B79F5;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

export function sortHand(cards) {
  return cards.slice().sort((a, b) => b.r - a.r || (suitOrd(a) - suitOrd(b)));
}
function suitOrd(c) { return typeof c.s === 'number' ? c.s : (c.s === 'X' ? 5 : 4); }

// ---- 牌型识别 ----
const TYPE_NAME = {
  single: '单牌', pair: '对子', trio: '三张', trio_single: '三带一', trio_pair: '三带二',
  straight: '顺子', straight_pair: '连对', plane: '飞机', plane_single: '飞机带单',
  plane_pair: '飞机带对', four_two_single: '四带二', four_two_pair: '四带两对',
  bomb: '炸弹', rocket: '王炸',
};
export function comboName(t) { return TYPE_NAME[t] || t; }

function counts(cards) {
  const m = {};
  for (const c of cards) m[c.r] = (m[c.r] || 0) + 1;
  return m;
}
function byCountBuckets(cnt) {
  const b = { 1: [], 2: [], 3: [], 4: [] };
  for (const r in cnt) b[cnt[r]].push(+r);
  for (const k in b) b[k].sort((a, x) => a - x);
  return b;
}
function consecutive(sorted, maxAllowed = 14) {
  if (sorted.length === 0) return false;
  if (sorted[sorted.length - 1] > maxAllowed) return false; // 不含 2/王
  for (let i = 1; i < sorted.length; i++) if (sorted[i] !== sorted[i - 1] + 1) return false;
  return true;
}

// 返回 {type, len, key} 或 null。len 用于顺子/连对/飞机的长度比较。
export function parseCombo(cards) {
  const n = cards.length;
  if (n === 0) return null;
  const cnt = counts(cards);
  const b = byCountBuckets(cnt);
  const ranks = Object.keys(cnt).map(Number);

  if (n === 1) return { type: 'single', len: 1, key: ranks[0] };
  if (n === 2) {
    if (b[1].length === 2 && b[1].includes(16) && b[1].includes(17)) return { type: 'rocket', len: 1, key: 100 };
    if (b[2].length === 1) return { type: 'pair', len: 1, key: b[2][0] };
    return null;
  }
  if (n === 3) { if (b[3].length === 1) return { type: 'trio', len: 1, key: b[3][0] }; return null; }
  if (n === 4) {
    if (b[4].length === 1) return { type: 'bomb', len: 1, key: b[4][0] };
    if (b[3].length === 1 && b[1].length === 1) return { type: 'trio_single', len: 1, key: b[3][0] };
    return null;
  }

  // n>=5
  // 顺子
  if (b[2].length === 0 && b[3].length === 0 && b[4].length === 0 && b[1].length === n && consecutive(b[1]) && n >= 5)
    return { type: 'straight', len: n, key: Math.max(...b[1]) };
  // 连对
  if (n % 2 === 0 && b[1].length === 0 && b[3].length === 0 && b[4].length === 0 && b[2].length === n / 2 && b[2].length >= 3 && consecutive(b[2]))
    return { type: 'straight_pair', len: n / 2, key: Math.max(...b[2]) };
  // 飞机族（三连张只取 count===3 的，且不允许出现炸弹）
  const trios = b[3];
  if (trios.length >= 2 && b[4].length === 0 && consecutive(trios)) {
    const t = trios.length, top = trios[t - 1];
    if (n === 3 * t && b[1].length === 0 && b[2].length === 0) return { type: 'plane', len: t, key: top };
    if (n === 4 * t) { const wing = b[1].length + b[2].length * 2; if (wing === t) return { type: 'plane_single', len: t, key: top }; }
    if (n === 5 * t) { if (b[2].length === t && b[1].length === 0) return { type: 'plane_pair', len: t, key: top }; }
  }
  // 三带二
  if (n === 5 && b[3].length === 1 && b[2].length === 1) return { type: 'trio_pair', len: 1, key: b[3][0] };
  // 四带二（单）/四带两对
  if (n === 6 && b[4].length === 1) {
    if (b[1].length === 2 || b[2].length === 1) return { type: 'four_two_single', len: 1, key: b[4][0] };
  }
  if (n === 8 && b[4].length === 1 && b[2].length === 2) return { type: 'four_two_pair', len: 1, key: b[4][0] };
  return null;
}

// a 能否压过 b（b 为当前需要跟的牌；b 为 null 时表示首出，任意合法牌型都可）
export function comboBeats(a, b) {
  if (!a) return false;
  if (!b) return true;
  if (a.type === 'rocket') return true;
  if (b.type === 'rocket') return false;
  if (a.type === 'bomb' && b.type !== 'bomb') return true;
  if (b.type === 'bomb' && a.type !== 'bomb') return false;
  if (a.type === b.type && a.len === b.len) return a.key > b.key;
  return false;
}

// ---- 找出手中所有能压过 target 的牌（含炸弹/王炸） ----
function byRank(cards) {
  const m = new Map();
  for (const c of cards) { if (!m.has(c.r)) m.set(c.r, []); m.get(c.r).push(c); }
  return m;
}
function smallestWing(map, excludeRanks, k, pairWing) {
  // 返回 k 个单牌(pairWing=false) 或 k 对(返回 2k 张) 的最小翼牌，避开 excludeRanks；找不到返回 null
  const need = pairWing ? 2 : 1;
  const out = [];
  const ranks = [...map.keys()].sort((a, b) => a - b);
  for (const r of ranks) {
    if (excludeRanks.includes(r)) continue;
    const arr = map.get(r);
    if (arr.length >= need) { out.push(arr.slice(0, need)); if (out.length === k) break; }
  }
  if (out.length < k) return null;
  return out.flat();
}

export function enumerateBeats(cards, target) {
  const res = [];
  const map = byRank(cards);
  const ranks = [...map.keys()].sort((a, b) => a - b);
  const has = r => (map.get(r) || []).length;
  const take = (r, k) => (map.get(r) || []).slice(0, k);
  const t = target;
  const add = arr => { if (arr && arr.length) res.push(arr); };

  if (t) {
    if (t.type === 'single') { for (const r of ranks) if (r > t.key && has(r) >= 1) add(take(r, 1)); }
    else if (t.type === 'pair') { for (const r of ranks) if (r > t.key && has(r) >= 2) add(take(r, 2)); }
    else if (t.type === 'trio') { for (const r of ranks) if (r > t.key && has(r) >= 3) add(take(r, 3)); }
    else if (t.type === 'trio_single') {
      for (const r of ranks) if (r > t.key && has(r) >= 3) { const w = smallestWing(map, [r], 1, false); if (w) add([...take(r, 3), ...w]); }
    } else if (t.type === 'trio_pair') {
      for (const r of ranks) if (r > t.key && has(r) >= 3) { const w = smallestWing(map, [r], 1, true); if (w) add([...take(r, 3), ...w]); }
    } else if (t.type === 'straight' || t.type === 'straight_pair') {
      const need = t.type === 'straight' ? 1 : 2;
      addStraights(map, t.len, t.key, need, add);
    } else if (t.type === 'plane' || t.type === 'plane_single' || t.type === 'plane_pair') {
      addPlanes(map, t, add);
    } else if (t.type === 'four_two_single' || t.type === 'four_two_pair') {
      const pairWing = t.type === 'four_two_pair';
      for (const r of ranks) if (r > t.key && has(r) >= 4) {
        const w = smallestWing(map, [r], 2, pairWing);
        if (w) add([...take(r, 4), ...w]);
      }
    }
  }
  // 炸弹永远可压（target 是炸弹则需更大；target 是王炸则不可）
  if (!t || t.type !== 'rocket') {
    for (const r of ranks) if (has(r) >= 4) { if (t && t.type === 'bomb') { if (r > t.key) add(take(r, 4)); } else add(take(r, 4)); }
    if (has(16) && has(17)) add([...take(16, 1), ...take(17, 1)]);
  }
  return res;
}

function addStraights(map, len, key, need, add) {
  // 窗口长 len 的连续点数(<=14)，每点 count>=need，且窗口最大点 > key
  for (let start = 3; start + len - 1 <= 14; start++) {
    const end = start + len - 1;
    if (end <= key) continue;
    let ok = true;
    for (let r = start; r <= end; r++) if (((map.get(r) || []).length) < need) { ok = false; break; }
    if (!ok) continue;
    const cards = [];
    for (let r = start; r <= end; r++) cards.push(...map.get(r).slice(0, need));
    add(cards);
  }
}
function addPlanes(map, t, add) {
  const len = t.len; // 三张连张数
  for (let start = 3; start + len - 1 <= 14; start++) {
    const end = start + len - 1;
    if (end <= t.key) continue;
    let ok = true;
    for (let r = start; r <= end; r++) if (((map.get(r) || []).length) < 3) { ok = false; break; }
    if (!ok) continue;
    const base = [];
    const exclude = [];
    for (let r = start; r <= end; r++) { base.push(...map.get(r).slice(0, 3)); exclude.push(r); }
    if (t.type === 'plane') { add(base); continue; }
    const pairWing = t.type === 'plane_pair';
    const w = smallestWing(map, exclude, len, pairWing);
    if (w) add([...base, ...w]);
  }
}

// 首出时可选的所有“起手”牌型（用于人类“提示”循环 & AI 候选）
export function leadOptions(cards) {
  const res = [];
  const map = byRank(cards);
  const ranks = [...map.keys()].sort((a, b) => a - b);
  const has = r => (map.get(r) || []).length;
  const take = (r, k) => map.get(r).slice(0, k);
  // 单 / 对 / 三 / 三带一 / 三带二
  for (const r of ranks) {
    res.push(take(r, 1));
    if (has(r) >= 2) res.push(take(r, 2));
    if (has(r) >= 3) {
      res.push(take(r, 3));
      const w1 = smallestWing(map, [r], 1, false); if (w1) res.push([...take(r, 3), ...w1]);
      const w2 = smallestWing(map, [r], 1, true); if (w2) res.push([...take(r, 3), ...w2]);
    }
  }
  // 顺子（5..最长）/ 连对 / 飞机
  for (let len = 5; len <= 12; len++) addStraights(map, len, 2, 1, a => res.push(a));
  for (let len = 3; len <= 10; len++) addStraights(map, len, 2, 2, a => res.push(a));
  for (let len = 2; len <= 6; len++) {
    addPlanes(map, { type: 'plane', len, key: 2 }, a => res.push(a));
    addPlanes(map, { type: 'plane_single', len, key: 2 }, a => res.push(a));
    addPlanes(map, { type: 'plane_pair', len, key: 2 }, a => res.push(a));
  }
  // 四带二
  for (const r of ranks) if (has(r) >= 4) {
    const w = smallestWing(map, [r], 2, false); if (w) res.push([...take(r, 4), ...w]);
    const wp = smallestWing(map, [r], 2, true); if (wp) res.push([...take(r, 4), ...wp]);
    res.push(take(r, 4)); // 炸弹
  }
  if (has(16) && has(17)) res.push([...take(16, 1), ...take(17, 1)]);
  // 去重 + 过滤非法
  const seen = new Set(), out = [];
  for (const a of res) {
    const cb = parseCombo(a); if (!cb) continue;
    const key = a.map(c => c.id).sort((x, y) => x - y).join(',');
    if (seen.has(key)) continue; seen.add(key); out.push(a);
  }
  return out;
}

// ---- 启发式 AI ----
// 叫分：基于王炸/炸弹/2/大牌评估，返回 0..3
export function aiBid(cards, current = 0) {
  let score = 0;
  const cnt = counts(cards);
  const has2 = (cnt[15] || 0), bj = cnt[16] || 0, rj = cnt[17] || 0;
  if (bj && rj) score += 3.0;            // 王炸
  else if (bj || rj) score += 1.0;       // 单王
  score += has2 * 1.2;                   // 每张 2
  for (const r in cnt) if (cnt[r] === 4) score += 2.5; // 炸弹
  score += (cnt[14] || 0) * 0.5;         // A
  score += (cnt[13] || 0) * 0.3;         // K
  let call = 0;
  if (score >= 7) call = 3; else if (score >= 4.5) call = 2; else if (score >= 2.6) call = 1;
  return call > current ? call : 0; // 不超过已叫分则不叫
}

// 估算手牌“手数”（越少越接近走完），用于辅助 AI 决策
function handSteps(cards) {
  // 贪心拆牌：火箭/炸弹各 1 手，顺子/连对/飞机尽量长，余下三带/对/单
  let pool = counts(cards);
  let steps = 0;
  const cntOf = r => pool[r] || 0;
  // 火箭
  if (cntOf(16) && cntOf(17)) { steps++; pool[16]--; pool[17]--; }
  // 炸弹
  for (let r = 3; r <= 17; r++) if (cntOf(r) === 4) { steps++; pool[r] = 0; }
  // 顺子（从长到短）
  for (let len = 12; len >= 5; len--) {
    for (let s = 3; s + len - 1 <= 14; s++) {
      let ok = true; for (let r = s; r < s + len; r++) if (cntOf(r) < 1) { ok = false; break; }
      if (ok) { steps++; for (let r = s; r < s + len; r++) pool[r]--; }
    }
  }
  // 连对
  for (let len = 10; len >= 3; len--) {
    for (let s = 3; s + len - 1 <= 14; s++) {
      let ok = true; for (let r = s; r < s + len; r++) if (cntOf(r) < 2) { ok = false; break; }
      if (ok) { steps++; for (let r = s; r < s + len; r++) pool[r] -= 2; }
    }
  }
  // 三张
  for (let r = 3; r <= 15; r++) while (cntOf(r) >= 3) { steps++; pool[r] -= 3; }
  // 对子
  for (let r = 3; r <= 17; r++) while (cntOf(r) >= 2) { steps++; pool[r] -= 2; }
  // 单牌
  for (let r = 3; r <= 17; r++) steps += cntOf(r);
  return steps;
}

// AI 决策：返回要出的 cards 数组，或 null（不要 / 首出必须出则给最小）。
// ctx: { target, mustPlay(首出), myRole, targetRole, myCount, oppMinCount }
export function aiPlay(cards, ctx) {
  const { target, mustPlay, myRole, targetRole, oppMinCount = 99 } = ctx;
  if (mustPlay || !target) return aiLead(cards, ctx);

  // 跟牌
  let beats = enumerateBeats(cards, target);
  if (beats.length === 0) return null;
  const myCount = cards.length;
  // 队友出的牌：农民之间默认不压（除非自己能一手走完）
  const isTeammate = targetRole && myRole && targetRole === myRole && myRole === 'farmer';
  if (isTeammate) {
    // 能直接打光且这手刚好是整副 → 出，否则让队友
    const exact = beats.find(b => b.length === myCount && parseCombo(b));
    if (exact) return exact;
    return null;
  }
  // 对手出的牌：挑“最小且不是炸弹/王炸”的来压
  const nonBomb = beats.filter(b => { const c = parseCombo(b); return c && c.type !== 'bomb' && c.type !== 'rocket'; });
  const bombs = beats.filter(b => { const c = parseCombo(b); return c && (c.type === 'bomb' || c.type === 'rocket'); });
  const score = b => b.length + parseCombo(b).key / 100; // 越小越优先
  nonBomb.sort((a, b) => score(a) - score(b));
  if (nonBomb.length) {
    // 若能正好走完，必出
    const exact = nonBomb.find(b => b.length === myCount);
    if (exact) return exact;
    // 不要为压一张小单牌而拆掉很大的牌：若需用到 2/王 压单且自己牌还多，可考虑过（简单阈值）
    const best = nonBomb[0];
    const cb = parseCombo(best);
    if (target.type === 'single' && cb.key >= 15 && myCount > 4 && target.key < 11) {
      // 对方出小单，自己只能用 2/王 压，牌还多 → 过
      return null;
    }
    return best;
  }
  // 只能用炸弹：对手快走完(<=2 手内) 或自己能一击走完才炸
  bombs.sort((a, b) => a.length - b.length || parseCombo(a).key - parseCombo(b).key);
  if (oppMinCount <= 2 || myRole === 'farmer' && targetRole === 'landlord' && oppMinCount <= 3) return bombs[0];
  return null;
}

function aiLead(cards, ctx) {
  const opts = leadOptions(cards).filter(o => o.length);
  if (opts.length === 0) return cards.slice(0, 1);
  const myCount = cards.length;
  // 能一手走完优先
  const win = opts.find(o => o.length === myCount && parseCombo(o));
  if (win) return win;
  const rank = o => {
    const c = parseCombo(o);
    let pri = 5;
    if (c.type === 'straight' || c.type === 'straight_pair' || c.type.startsWith('plane')) pri = 0; // 优先甩长条
    else if (c.type === 'trio' || c.type === 'trio_single' || c.type === 'trio_pair') pri = 1;
    else if (c.type === 'single') pri = 2;
    else if (c.type === 'pair') pri = 3;
    else if (c.type === 'bomb' || c.type === 'rocket') pri = 9; // 炸弹/王炸不轻易首出
    else pri = 4;
    return [pri, c.key, -o.length];
  };
  opts.sort((a, b) => { const ra = rank(a), rb = rank(b); return ra[0] - rb[0] || ra[1] - rb[1] || ra[2] - rb[2]; });
  // 避免首出就甩 2/王单张（保留控牌）：若最优是 2/王 的单/对，挑次优非大牌
  for (const o of opts) {
    const c = parseCombo(o);
    if ((c.type === 'bomb' || c.type === 'rocket')) continue;
    if ((c.type === 'single' || c.type === 'pair') && c.key >= 15 && opts.length > 3) continue;
    return o;
  }
  return opts[0];
}

export const __engine = { parseCombo, comboBeats, enumerateBeats, handSteps, leadOptions };

/* ============================================================================
 * DoudizhuGame — 可序列化、服务端权威的斗地主状态机
 *   单机（浏览器内运行）与联机后端（functions/api/poker-ddz.js）共用同一份逻辑，
 *   区别只在“谁提供人类输入”。座位 0/1/2，出牌顺序 0->1->2。
 *   牌仍用 {r,s,id} 对象；id 在一副牌内唯一（0..53），客户端按 id 匹配选牌。
 * ========================================================================== */

// 不可压牌型的“手数权重”——给 AI 用，已在 handSteps 里有更完整版本，这里复用
function comboKindOf(cards) { const c = parseCombo(cards); return c ? c.type : null; }

export class DoudizhuGame {
  // opts: { names?, isAI?, seed?, dealer? }
  constructor(opts = {}) {
    if (opts.__raw) { this.s = opts.__raw; return; }   // from() 走这条
    const names = opts.names || ['你', '下家', '上家'];
    const isAI = opts.isAI || [false, true, true];
    const rng = mulberry32((opts.seed ?? ((Date.now() ^ (Math.random() * 1e9)) >>> 0)));
    this.s = this._deal(names, isAI, rng, opts.dealer);
  }

  _deal(names, isAI, rng, dealer) {
    const deck = shuffle(makeDeck(), rng);
    const hands = [sortHand(deck.slice(0, 17)), sortHand(deck.slice(17, 34)), sortHand(deck.slice(34, 51))];
    const bottom = deck.slice(51, 54);
    const start = (dealer == null) ? Math.floor(rng() * 3) : (dealer % 3);
    return {
      names: names.slice(0, 3), isAI: isAI.slice(0, 3),
      hands, bottom, landlord: -1, roles: [null, null, null],
      phase: 'bid', turn: start,
      bid: { order: [start, (start + 1) % 3, (start + 2) % 3], idx: 0, max: 0, leader: -1, calls: [null, null, null] },
      target: null, targetSeat: -1, passes: 0,
      lastPlay: [null, null, null],
      multiplier: 0, bombs: 0, base: 0,
      everFarmerPlayed: false, llPlays: 0,
      result: null, log: [], startSeat: start, redeals: 0,
    };
  }

  // 重新发一副（叫分无人叫时 / 联机 reset），保留名字与 AI 标记，换庄
  redeal() {
    const s = this.s;
    const rng = mulberry32(((Date.now() ^ (Math.random() * 1e9)) >>> 0));
    const dealer = (s.startSeat + 1) % 3;
    const redeals = s.redeals + 1;
    this.s = this._deal(s.names, s.isAI, rng, dealer);
    this.s.redeals = redeals;
    return this;
  }

  _log(t) { this.s.log.push(t); if (this.s.log.length > 40) this.s.log = this.s.log.slice(-40); }
  _name(i) { return this.s.names[i] || ['你', '下家', '上家'][i]; }

  /* ---------------- 叫分 ---------------- */
  bidOptions() {
    const s = this.s; if (s.phase !== 'bid') return [];
    const opts = [0];
    for (let v = 1; v <= 3; v++) if (v > s.bid.max) opts.push(v);
    return opts;
  }
  bid(seat, call) {
    const s = this.s;
    if (s.phase !== 'bid') return { ok: false };
    if (s.bid.order[s.bid.idx] !== seat) return { ok: false };
    call = call | 0;
    if (call !== 0 && (call <= s.bid.max || call > 3)) return { ok: false };
    s.bid.calls[seat] = call;
    if (call > s.bid.max) { s.bid.max = call; s.bid.leader = seat; this._log(this._name(seat) + ' 叫 ' + call + ' 分'); }
    else this._log(this._name(seat) + ' 不叫');
    s.bid.idx++;
    if (s.bid.idx >= 3 || s.bid.max === 3) this._finishBidding();
    else s.turn = s.bid.order[s.bid.idx];
    return { ok: true };
  }
  aiBidTurn(seat) {
    const s = this.s;
    const call = aiBid(s.hands[seat], s.bid.max);
    return this.bid(seat, call);
  }
  _finishBidding() {
    const s = this.s;
    if (s.bid.max === 0) { this.redeal(); return; }    // 无人叫 → 重发
    const ll = s.bid.leader;
    s.landlord = ll;
    s.roles = [0, 1, 2].map(i => (i === ll ? 'landlord' : 'farmer'));
    s.hands[ll] = sortHand(s.hands[ll].concat(s.bottom));
    s.base = s.bid.max; s.multiplier = s.bid.max;
    s.phase = 'play'; s.turn = ll; s.target = null; s.targetSeat = -1; s.passes = 0;
    s.lastPlay = [null, null, null];
    this._log(this._name(ll) + ' 当地主（底分 ' + s.bid.max + '）');
  }

  /* ---------------- 出牌 ---------------- */
  // 出牌；cards 为 {r,s,id} 数组（必须是手牌子集）。返回 {ok, err?}
  play(seat, cards) {
    const s = this.s;
    if (s.phase !== 'play' || s.turn !== seat) return { ok: false, err: 'turn' };
    if (!Array.isArray(cards) || !cards.length) return { ok: false, err: 'empty' };
    const handIds = new Set(s.hands[seat].map(c => c.id));
    if (!cards.every(c => handIds.has(c.id))) return { ok: false, err: 'nothand' };
    const cb = parseCombo(cards);
    if (!cb) return { ok: false, err: 'badcombo' };
    if (s.target && !comboBeats(cb, s.target)) return { ok: false, err: 'small' };
    const ids = new Set(cards.map(c => c.id));
    s.hands[seat] = s.hands[seat].filter(c => !ids.has(c.id));
    s.lastPlay[seat] = cards.slice();
    if (cb.type === 'bomb' || cb.type === 'rocket') { s.bombs++; s.multiplier *= 2; }
    if (s.roles[seat] === 'landlord') s.llPlays++; else s.everFarmerPlayed = true;
    s.target = { type: cb.type, len: cb.len, key: cb.key }; s.targetSeat = seat; s.passes = 0;
    this._log(this._name(seat) + ' 出 ' + comboName(cb.type));
    if (s.hands[seat].length === 0) { this._endGame(seat); return { ok: true }; }
    s.turn = (seat + 1) % 3;
    return { ok: true };
  }
  // 由引擎按 id 还原牌对象再出牌（联机后端用，客户端只传 id 数组）
  playByIds(seat, ids) {
    const hand = this.s.hands[seat] || [];
    const map = new Map(hand.map(c => [c.id, c]));
    const cards = ids.map(id => map.get(id | 0)).filter(Boolean);
    if (cards.length !== ids.length) return { ok: false, err: 'nothand' };
    return this.play(seat, cards);
  }
  pass(seat) {
    const s = this.s;
    if (s.phase !== 'play' || s.turn !== seat) return { ok: false, err: 'turn' };
    if (s.target === null) return { ok: false, err: 'mustplay' };   // 首出不能过
    s.lastPlay[seat] = 'pass'; s.passes++;
    this._log(this._name(seat) + ' 不要');
    if (s.passes >= 2) { s.target = null; s.targetSeat = -1; s.passes = 0; s.lastPlay = [null, null, null]; }
    s.turn = (seat + 1) % 3;
    return { ok: true };
  }
  // AI 行动一步：自动出牌或过
  aiActTurn(seat) {
    const s = this.s;
    const mustPlay = s.target === null;
    const oppMin = Math.min(...[0, 1, 2].filter(i => i !== seat).map(i => s.hands[i].length));
    const play = aiPlay(s.hands[seat], {
      target: mustPlay ? null : s.target, mustPlay, myRole: s.roles[seat],
      targetRole: s.targetSeat >= 0 ? s.roles[s.targetSeat] : null, oppMinCount: oppMin,
    });
    if (play && play.length) return this.play(seat, play);
    return this.pass(seat);
  }

  _endGame(winner) {
    const s = this.s;
    const farmersWin = s.roles[winner] === 'farmer';
    let spring = false;
    if (!farmersWin && !s.everFarmerPlayed) spring = true;          // 地主春天
    else if (farmersWin && s.llPlays <= 1) spring = true;           // 农民反春天
    if (spring) s.multiplier *= 2;
    s.phase = 'end';
    s.result = {
      winner, farmersWin, spring,
      base: s.base, multiplier: s.multiplier, bombs: s.bombs,
      factor: s.base ? s.multiplier / s.base : 1,
    };
    this._log((farmersWin ? '农民胜' : '地主胜') + (spring ? '·春天' : '') + '，共 ' + s.multiplier + ' 倍');
  }

  /* ---------------- 视图（隐藏他人手牌） ---------------- */
  publicView(seat) {
    const s = this.s;
    const ended = s.phase === 'end';
    const players = [0, 1, 2].map(i => ({
      name: this._name(i), ai: s.isAI[i], role: s.roles[i],
      handCount: s.hands[i].length,
      hand: (i === seat || ended) ? s.hands[i] : null,
      lastPlay: s.lastPlay[i],
    }));
    return {
      phase: s.phase, turn: s.turn, landlord: s.landlord, roles: s.roles,
      mySeat: seat, players,
      bottom: (s.landlord >= 0 || ended) ? s.bottom : null,
      bid: s.phase === 'bid' ? { order: s.bid.order, idx: s.bid.idx, max: s.bid.max, leader: s.bid.leader, calls: s.bid.calls.slice(), options: this.bidOptions() } : null,
      target: s.target, targetSeat: s.targetSeat, passes: s.passes,
      base: s.base, multiplier: s.multiplier, bombs: s.bombs,
      result: s.result, log: s.log.slice(-12),
    };
  }

  /* ---------------- 序列化 ---------------- */
  toJSON() { return this.s; }
  static from(raw) { return raw ? new DoudizhuGame({ __raw: raw }) : null; }
}

// 把所有“该 AI 行动”的步骤推进完（叫分 + 出牌都自动跑 AI）。无定时窗口。
export function ddzAdvance(g) {
  const s = g.s;
  let guard = 0;
  while (guard++ < 600) {
    if (s.phase === 'end') return;
    const seat = s.turn;
    if (!s.isAI[seat]) return;          // 轮到真人 → 停
    if (s.phase === 'bid') { g.aiBidTurn(seat); continue; }
    if (s.phase === 'play') { g.aiActTurn(seat); continue; }
    return;
  }
}
