/*!
 * scmj-engine.js — 四川麻将（血战到底）规则引擎
 * 纯逻辑，无 DOM。单机页面与联机后端共用。
 *
 * 牌编码：0..26 共 27 种
 *   0..8   = 万(m) 1..9
 *   9..17  = 筒(p) 1..9
 *   18..26 = 条(s) 1..9
 * 花色 suit = (id/9|0)  0=m,1=p,2=s   点数 rank = id%9 + 1
 * 一副牌 108 张 = 每种 ×4，无字牌无花牌。
 *
 * 设计：
 *  - 一组纯函数做规则数学（和了/听牌/向听/算分），可单测。
 *  - 一个 SCMJGame 控制器持有可序列化 state，驱动血战到底流程；
 *    单机与联机都调它，区别只在"谁提供人类输入"。
 */

export const SUITS = ['m', 'p', 's'];
export const SUIT_NAME = { m: '万', p: '筒', s: '条' };
export const suitOf = (id) => (id / 9) | 0;
export const rankOf = (id) => (id % 9) + 1;
export const tid = (suit, rank) => suit * 9 + (rank - 1);
export const tstr = (id) => SUITS[suitOf(id)] + rankOf(id);
export function parseTile(s) {
  const m = /^([mps])([1-9])$/.exec(s);
  if (!m) return -1;
  return tid(SUITS.indexOf(m[1]), +m[2]);
}

// ---- RNG (seedable, 联机用同一 seed 复现) ----
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = (rng() * (i + 1)) | 0;
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
export function freshWall(rng) {
  const w = [];
  for (let id = 0; id < 27; id++) for (let k = 0; k < 4; k++) w.push(id);
  return shuffle(w, rng);
}

// ---- 手牌计数 ----
export function emptyCounts() { return new Array(27).fill(0); }
export function listToCounts(list) {
  const c = emptyCounts();
  for (const id of list) c[id]++;
  return c;
}
export function countsToList(c) {
  const out = [];
  for (let i = 0; i < 27; i++) for (let k = 0; k < c[i]; k++) out.push(i);
  return out;
}
const sum = (c) => c.reduce((a, b) => a + b, 0);

// ============================================================
//  和了判定
// ============================================================

// 标准型：cnt(27) 能否拆成 needSets 个面子（刻/顺）+ 1 个对子，全部用尽。
function canFormSetsPlusPair(cnt) {
  const c = cnt.slice();
  // 选一个对子
  for (let p = 0; p < 27; p++) {
    if (c[p] >= 2) {
      c[p] -= 2;
      if (formsAllSets(c)) { c[p] += 2; return true; }
      c[p] += 2;
    }
  }
  return false;
}
// cnt 能否完全拆成若干面子（刻/顺），无剩余
function formsAllSets(cnt) {
  const c = cnt.slice();
  let i = 0;
  while (i < 27 && c[i] === 0) i++;
  if (i === 27) return true;
  const rank = i % 9;
  // 刻子
  if (c[i] >= 3) {
    c[i] -= 3;
    if (formsAllSets(c)) return true;
    c[i] += 3;
  }
  // 顺子（同花色内 rank<=7）
  if (rank <= 6 && c[i + 1] > 0 && c[i + 2] > 0) {
    c[i]--; c[i + 1]--; c[i + 2]--;
    if (formsAllSets(c)) return true;
    c[i]++; c[i + 1]++; c[i + 2]++;
  }
  return false;
}

// 七对判定（concealed 14 张，无副露）。返回 {win, gangs} gangs=四张一组的数量(龙)
export function chiitoiInfo(cnt) {
  if (sum(cnt) !== 14) return { win: false, gangs: 0 };
  let gangs = 0;
  for (let i = 0; i < 27; i++) {
    if (cnt[i] % 2 !== 0) return { win: false, gangs: 0 };
    if (cnt[i] === 4) gangs++;
  }
  return { win: true, gangs };
}

// 缺门是否已打清（hu 前置）
export function queCleared(cnt, que) {
  if (que == null) return true;
  for (let r = 0; r < 9; r++) if (cnt[que * 9 + r] > 0) return false;
  return true;
}

// 综合和了判定。cnt=concealed(含和牌张)，meldsCount=副露面子数，que=缺门
export function canHu(cnt, meldsCount, que) {
  if (!queCleared(cnt, que)) return false;
  const total = sum(cnt);
  // 七对（仅门清）
  if (meldsCount === 0 && total === 14 && chiitoiInfo(cnt).win) return true;
  // 标准型：concealed 张数应为 3k+2
  if (total % 3 !== 2) return false;
  return canFormSetsPlusPair(cnt);
}

// 听牌的张：返回能让 cnt 和牌的牌 id 列表（不含缺门牌）
export function tingTiles(cnt, meldsCount, que) {
  const out = [];
  for (let t = 0; t < 27; t++) {
    if (cnt[t] >= 4) continue;
    if (que != null && suitOf(t) === que) continue;
    cnt[t]++;
    if (canHu(cnt, meldsCount, que)) out.push(t);
    cnt[t]--;
  }
  return out;
}
export function isTing(cnt, meldsCount, que) {
  return tingTiles(cnt, meldsCount, que).length > 0;
}

// ---- 向听数（标准型，AI 用） ----
function stdShanten(cnt, needSets) {
  let best = 99;
  const c = cnt.slice();
  function dfs(p, sets, part, pair) {
    while (p < 27 && c[p] === 0) p++;
    if (p === 27) {
      const usable = Math.min(part, needSets - sets);
      const s = (needSets - sets) * 2 - usable - (pair ? 1 : 0);
      if (s < best) best = s;
      return;
    }
    const rank = p % 9;
    // 刻子
    if (c[p] >= 3) { c[p] -= 3; dfs(p, sets + 1, part, pair); c[p] += 3; }
    // 顺子
    if (rank <= 6 && c[p + 1] > 0 && c[p + 2] > 0) {
      c[p]--; c[p + 1]--; c[p + 2]--; dfs(p, sets + 1, part, pair); c[p]++; c[p + 1]++; c[p + 2]++;
    }
    // 对子作雀头
    if (c[p] >= 2 && !pair) { c[p] -= 2; dfs(p, sets, part, true); c[p] += 2; }
    // 搭子：对子
    if (c[p] >= 2 && sets + part < needSets) { c[p] -= 2; dfs(p, sets, part + 1, pair); c[p] += 2; }
    // 搭子：两面/边张
    if (rank <= 7 && c[p + 1] > 0 && sets + part < needSets) { c[p]--; c[p + 1]--; dfs(p, sets, part + 1, pair); c[p]++; c[p + 1]++; }
    // 搭子：嵌张
    if (rank <= 6 && c[p + 2] > 0 && sets + part < needSets) { c[p]--; c[p + 2]--; dfs(p, sets, part + 1, pair); c[p]++; c[p + 2]++; }
    // 孤张跳过
    c[p]--; dfs(p, sets, part, pair); c[p]++;
  }
  dfs(0, 0, 0, false);
  return best;
}
function chiitoiShanten(cnt) {
  let pairs = 0, kinds = 0;
  for (let i = 0; i < 27; i++) {
    if (cnt[i] > 0) kinds++;
    if (cnt[i] >= 2) pairs++;
  }
  return 6 - pairs + Math.max(0, 7 - kinds);
}
// 综合向听（含缺门惩罚：缺门牌算作必须打出，未清缺无法和）
export function shanten(cnt, meldsCount, que) {
  const c = cnt.slice();
  let quePenalty = 0;
  if (que != null) {
    for (let r = 0; r < 9; r++) { quePenalty += c[que * 9 + r]; c[que * 9 + r] = 0; }
  }
  const needSets = 4 - meldsCount;
  let s = stdShanten(c, needSets);
  if (meldsCount === 0) s = Math.min(s, chiitoiShanten(c));
  // 缺门牌仍在手 → 至少还要这么多次有效进张腾位置，粗略 +1 表示未清缺
  return s + (quePenalty > 0 ? quePenalty : 0);
}

// ============================================================
//  番型算分
// ============================================================
export const DEFAULT_RULE = {
  di: 1,          // 底分
  maxFan: 4,      // 番数封顶（不含根）— 倍 = 2^min(fan,maxFan) × 2^根
  capRoot: true,  // 根是否一起封顶
  zimoFan: 1, pengpengFan: 1, qingyiseFan: 2, qiduiFan: 2,
  jiangduiFan: 2, jingouFan: 1, ganghuaFan: 1, qianggangFan: 1, haidiFan: 1,
  tianhuFan: 6,
  // —— 变体开关 ——
  variant: 'sichuan',
  dingque: true,        // 是否定缺
  allowChi: false,      // 是否可吃
  bloodBattle: true,    // 血战到底（多胡）/ 单赢一局
  liujuSettle: 'sichuan', // 流局结算：'sichuan'(查叫查花猪) / 'none'(荒庄)
};
// 变体预设
export const RULES = {
  sichuan: () => Object.assign({}, DEFAULT_RULE, {
    variant: 'sichuan', dingque: true, allowChi: false, bloodBattle: true, liujuSettle: 'sichuan',
  }),
  changsha: () => Object.assign({}, DEFAULT_RULE, {
    variant: 'changsha', dingque: false, allowChi: true, bloodBattle: false, liujuSettle: 'none',
  }),
};
export function ruleFor(variant, over) {
  const base = (RULES[variant] || RULES.sichuan)();
  return Object.assign(base, over || {});
}

// 吃：返回能与 tile 组成顺子的顺子起始牌 low 列表（同花色，需手里另两张）。
export function chiOptions(cnt, tile) {
  const out = [];
  const s = suitOf(tile), r = rankOf(tile);      // r:1..9
  const has = (rank) => rank >= 1 && rank <= 9 && cnt[s * 9 + (rank - 1)] > 0;
  if (has(r - 2) && has(r - 1)) out.push(s * 9 + (r - 3));   // low = r-2
  if (has(r - 1) && has(r + 1)) out.push(s * 9 + (r - 2));   // low = r-1
  if (has(r + 1) && has(r + 2)) out.push(s * 9 + (r - 1));   // low = r
  return out;
}

// concealed 含和牌张; melds=[{type,tile}]; 返回 {fanList,fan,bei,points,type,name}
export function scoreWin(opts) {
  const rule = Object.assign({}, DEFAULT_RULE, opts.rule || {});
  const cnt = opts.cnt.slice();
  const melds = opts.melds || [];
  const flags = opts.flags || {};
  const fanList = [];
  const add = (name, fan) => { if (fan) fanList.push({ name, fan }); };

  const meldsCount = melds.length;
  const total = sum(cnt);
  const allTiles = cnt.slice();
  for (const m of melds) {
    if (m.type === 'chi') { allTiles[m.tile]++; allTiles[m.tile + 1]++; allTiles[m.tile + 2]++; }
    else allTiles[m.tile] += (m.type === 'gang' || m.type === 'angang' || m.type === 'bugang') ? 4 : 3;
  }
  const noChi = melds.every(m => m.type !== 'chi');

  // —— 牌型 ——
  let isQidui = false, qiduiGangs = 0;
  if (meldsCount === 0 && total === 14) {
    const qi = chiitoiInfo(cnt);
    if (qi.win) { isQidui = true; qiduiGangs = qi.gangs; }
  }
  const allTriplets = !isQidui && noChi && isAllTriplets(cnt);
  // 清一色：所有牌同花色
  let suitsUsed = new Set();
  for (let i = 0; i < 27; i++) if (allTiles[i] > 0) suitsUsed.add(suitOf(i));
  const qingyise = suitsUsed.size === 1;
  // 将对：碰碰胡且全为 2/5/8
  let allJiang = true;
  for (let i = 0; i < 27; i++) if (allTiles[i] > 0 && ![2, 5, 8].includes(rankOf(i))) allJiang = false;
  const jiangdui = allTriplets && allJiang;
  // 金钩钓：碰碰胡且手内只剩雀头（4 副露全杠/碰，单吊）
  const jingou = allTriplets && total === 2;

  let typeName = '平胡';
  if (isQidui) {
    if (qiduiGangs > 0) { add('龙七对', 2 + qiduiGangs); typeName = '龙七对'; }   // 七对(2)+每条龙+1
    else { add('七对', rule.qiduiFan); typeName = '七对'; }
  } else if (jiangdui) {
    add('将对', rule.jiangduiFan + rule.pengpengFan); typeName = '将对';
  } else if (jingou) {
    add('金钩钓', rule.pengpengFan + rule.jingouFan); typeName = '金钩钓';
  } else if (allTriplets) {
    add('碰碰胡', rule.pengpengFan); typeName = '碰碰胡';
  }
  if (qingyise) add('清一色', rule.qingyiseFan);

  // —— 根（七对里的龙已计入，不重复算根）——
  if (!isQidui) {
    let roots = 0;
    for (let i = 0; i < 27; i++) if (allTiles[i] === 4) roots++;
    if (roots) add('根×' + roots, roots);
  }

  // —— 自摸/特殊 ——
  if (opts.isZimo) add('自摸', rule.zimoFan);
  if (flags.ganghua) add('杠上开花', rule.ganghuaFan);
  if (flags.qianggang) add('抢杠胡', rule.qianggangFan);
  if (flags.haidi) add(opts.isZimo ? '海底捞月' : '海底炮', rule.haidiFan);
  if (flags.tianhu) add('天胡', rule.tianhuFan);
  if (flags.dihu) add('地胡', rule.tianhuFan);

  let baseFan = fanList.reduce((a, b) => a + b.fan, 0);
  // 封顶：番数(不含根)封顶 maxFan；根另算（或一起封顶）
  let fan = baseFan;
  if (rule.capRoot) fan = Math.min(fan, rule.maxFan + 8);
  else fan = Math.min(fan, rule.maxFan);
  const bei = Math.pow(2, fan);
  const points = rule.di * bei;
  return { fanList, fan, bei, points, type: typeName };
}

// concealed 是否 = 若干刻子 + 1 对子（碰碰胡的手内部分）
function isAllTriplets(cnt) {
  const c = cnt.slice();
  let pair = -1;
  for (let i = 0; i < 27; i++) {
    if (c[i] % 3 === 2) { if (pair >= 0) return false; pair = i; c[i] -= 2; }
  }
  if (pair < 0) {
    // 没有对子也行吗？需恰好一个雀头 → 必须有
    return false;
  }
  for (let i = 0; i < 27; i++) if (c[i] % 3 !== 0) return false;
  return true;
}

// ============================================================
//  AI 决策（启发式）
// ============================================================
// 选缺：选张数最少的花色（并列时选孤张多/无搭子的）
export function aiChooseQue(cnt) {
  let best = 0, bestScore = 1e9;
  for (let s = 0; s < 3; s++) {
    let n = 0, conn = 0;
    for (let r = 0; r < 9; r++) {
      const v = cnt[s * 9 + r];
      n += v;
      if (v >= 2) conn += 2;
      if (r <= 7 && cnt[s * 9 + r] > 0 && cnt[s * 9 + r + 1] > 0) conn += 1;
    }
    const score = n * 10 + conn;   // 牌少且搭子少者优先弃
    if (score < bestScore) { bestScore = score; best = s; }
  }
  return best;
}

// 选弃牌：优先打缺门；否则打使向听最小、进张最多的牌
export function aiDiscard(cnt, que, meldsCount) {
  // 缺门牌一律先打（打点数最大的那张以略减信息）
  if (que != null) {
    for (let r = 8; r >= 0; r--) { const id = que * 9 + r; if (cnt[id] > 0) return id; }
  }
  let bestTile = -1, bestKey = null;
  for (let t = 0; t < 27; t++) {
    if (cnt[t] === 0) continue;
    cnt[t]--;
    const sh = shanten(cnt, meldsCount, que);
    const ukeire = countUkeire(cnt, meldsCount, que);
    cnt[t]++;
    const key = [sh, -ukeire, edgePenalty(t)];
    if (bestKey === null || lessKey(key, bestKey)) { bestKey = key; bestTile = t; }
  }
  return bestTile;
}
function lessKey(a, b) {
  for (let i = 0; i < a.length; i++) { if (a[i] !== b[i]) return a[i] < b[i]; }
  return false;
}
function edgePenalty(t) { const r = rankOf(t); return (r === 1 || r === 9) ? 0 : (r === 2 || r === 8) ? 1 : 2; }
// 进张数：能降低向听的牌种数×剩余可能（粗略，按牌种计）
function countUkeire(cnt, meldsCount, que) {
  const base = shanten(cnt, meldsCount, que);
  let n = 0;
  for (let t = 0; t < 27; t++) {
    if (cnt[t] >= 4) continue;
    if (que != null && suitOf(t) === que) continue;
    cnt[t]++;
    if (shanten(cnt, meldsCount, que) < base) n += (4 - (cnt[t] - 1));
    cnt[t]--;
  }
  return n;
}

// AI 是否碰：碰后向听不增、且非门清七对路线时倾向碰对子型
export function aiShouldPeng(cnt, que, meldsCount, tile) {
  if (que != null && suitOf(tile) === que) return false;
  if (cnt[tile] < 2) return false;
  // 模拟碰：移走两张，副露+1，看向听是否改善或持平
  const before = shanten(cnt, meldsCount, que);
  cnt[tile] -= 2;
  const after = shanten(cnt, meldsCount + 1, que);
  cnt[tile] += 2;
  // 七对路线不碰
  if (meldsCount === 0 && chiitoiShanten(quelessCounts(cnt, que)) <= before) return false;
  return after <= before;
}
function quelessCounts(cnt, que) {
  const c = cnt.slice();
  if (que != null) for (let r = 0; r < 9; r++) c[que * 9 + r] = 0;
  return c;
}
// AI 选吃：返回使吃后向听最小的顺子起始 low；无改善则 null
export function aiChooseChi(cnt, que, meldsCount, tile, lows) {
  const before = shanten(cnt, meldsCount, que);
  let best = null, bestSh = Infinity;
  for (const low of lows) {
    const c = cnt.slice();
    for (const t of [low, low + 1, low + 2]) if (t !== tile) c[t]--;
    const sh = shanten(c, meldsCount + 1, que);
    if (sh < bestSh) { bestSh = sh; best = low; }
  }
  return (best != null && bestSh < before) ? best : null;
}
// AI 是否直杠（别人打出）：一般有利则杠（除非破坏听牌/七对）
export function aiShouldGangDiscard(cnt, que, meldsCount, tile) {
  if (que != null && suitOf(tile) === que) return false;
  if (cnt[tile] < 3) return false;
  if (meldsCount === 0 && isTing(quelessCounts(cnt, que), 0, null)) {
    // 门清听牌时杠要谨慎，简单起见仍杠（牌少更易自摸）
  }
  return true;
}

// ============================================================
//  血战到底 流程控制器
// ============================================================
//
// state 结构（可序列化）：
// {
//   rule, seed, dealer, turn, phase: 'dingque'|'play'|'window'|'end',
//   wall: [ids...], wpos, wend,            // wpos 前端摸牌, wend 尾端杠牌
//   players: [{ hand: counts27, melds:[{type,tile,from}], discards:[ids],
//               que, hu, huInfo, score, isAI, name, drawn }],
//   lastDraw: {seat,tile}|null,
//   window: { tile, from, responders:{seat:{opts:[],resp:null}}, } | null,
//   liveCount, log:[...], result:null
// }
//
export class SCMJGame {
  constructor(opts = {}) {
    if (opts.state) { this.s = opts.state; return; }
    const rule = Object.assign({}, DEFAULT_RULE, opts.rule || {});
    const seed = (opts.seed ?? (Math.random() * 2 ** 31)) | 0;
    const rng = mulberry32(seed);
    const wall = freshWall(rng);
    const dealer = opts.dealer ?? 0;
    const names = opts.names || ['你', '下家', '对家', '上家'];
    const isAI = opts.isAI || [false, true, true, true];
    const players = [];
    for (let i = 0; i < 4; i++) {
      players.push({
        hand: emptyCounts(), melds: [], discards: [],
        que: null, hu: false, huInfo: null, score: 0,
        isAI: !!isAI[i], name: names[i] || ('P' + i), drawn: null,
      });
    }
    // 发牌：每人 13，庄家 14
    let wpos = 0;
    for (let i = 0; i < 4; i++) {
      const seat = (dealer + i) % 4;
      const n = 13;
      for (let k = 0; k < n; k++) players[seat].hand[wall[wpos++]]++;
    }
    players[dealer].hand[wall[wpos]]++; players[dealer].drawn = wall[wpos]; wpos++;
    this.s = {
      rule, seed, dealer, turn: dealer, phase: rule.dingque ? 'dingque' : 'play',
      wall, wpos, wend: wall.length,
      players, lastDraw: { seat: dealer, tile: players[dealer].drawn },
      window: null, liveCount: 4, log: [], result: null,
    };
  }
  static from(state) { return new SCMJGame({ state }); }
  toJSON() { return this.s; }

  _log(e) { this.s.log.push(e); }
  player(seat) { return this.s.players[seat]; }
  meldsCount(seat) { return this.s.players[seat].melds.length; }

  // ---- 定缺 ----
  setQue(seat, suit) {
    const s = this.s;
    if (s.phase !== 'dingque') return false;
    if (s.players[seat].que != null) return false;
    s.players[seat].que = suit;
    this._log({ t: 'que', seat, suit });
    if (s.players.every(p => p.que != null)) {
      s.phase = 'play';
      s.turn = s.dealer;            // 庄家已有 14 张，待打牌
      this._log({ t: 'play_start', dealer: s.dealer });
    }
    return true;
  }
  allQueChosen() { return this.s.players.every(p => p.que != null); }

  // ---- 摸牌结束后，当前 turn 玩家可做什么 ----
  turnOptions(seat) {
    const s = this.s;
    if (s.phase !== 'play' || s.turn !== seat || s.players[seat].hu) return null;
    const p = s.players[seat];
    const opts = { discard: true, zimo: false, angang: [], bugang: [] };
    // 自摸
    if (canHu(p.hand, p.melds.length, p.que)) opts.zimo = true;
    // 暗杠：手内 4 张（非缺门）
    for (let t = 0; t < 27; t++) {
      if (p.hand[t] === 4 && !(p.que != null && suitOf(t) === p.que)) opts.angang.push(t);
    }
    // 补杠：已碰且手内有第 4 张
    for (const m of p.melds) {
      if (m.type === 'peng' && p.hand[m.tile] >= 1) opts.bugang.push(m.tile);
    }
    return opts;
  }

  // ---- 打牌 ----
  discard(seat, tile) {
    const s = this.s;
    if (s.phase !== 'play' || s.turn !== seat) return { ok: false };
    const p = s.players[seat];
    if (p.hand[tile] <= 0) return { ok: false };
    p.hand[tile]--; p.drawn = null;
    p.discards.push(tile);
    this._log({ t: 'discard', seat, tile });
    return this._openWindow(seat, tile, false);
  }

  // 打牌后开放响应窗口（点炮/碰/明杠）。bugangInfo: 抢杠时携带 {seat,tile}
  _openWindow(from, tile, isQiangGang, bugangInfo) {
    const s = this.s;
    const responders = {};
    for (let i = 1; i < 4; i++) {
      const seat = (from + i) % 4;
      const p = s.players[seat];
      if (p.hu) continue;
      const opts = [];
      // 胡（点炮）
      p.hand[tile]++;
      const canRon = canHu(p.hand, p.melds.length, p.que);
      p.hand[tile]--;
      if (canRon) opts.push('hu');
      let chi = null;
      if (!isQiangGang) {
        // 明杠
        if (p.hand[tile] === 3 && !(p.que != null && suitOf(tile) === p.que)) opts.push('gang');
        // 碰
        if (p.hand[tile] >= 2 && !(p.que != null && suitOf(tile) === p.que)) opts.push('peng');
        // 吃（仅下家、变体允许）
        if (s.rule.allowChi && seat === (from + 1) % 4) {
          const co = chiOptions(p.hand, tile);
          if (co.length) { opts.push('chi'); chi = co; }
        }
      }
      if (opts.length) responders[seat] = { opts, resp: null, chi };
    }
    s.window = { tile, from, isQiangGang, responders, haidi: s.wpos >= s.wend, _bugang: bugangInfo || null };
    if (Object.keys(responders).length === 0) {
      return this._closeWindow();
    }
    s.phase = 'window';
    return { ok: true, window: s.window };
  }

  windowResponders() {
    const w = this.s.window;
    return w ? Object.keys(w.responders).map(Number) : [];
  }
  // 玩家对窗口响应：action ∈ {'hu','peng','gang','pass'}
  respond(seat, action, meta) {
    const s = this.s;
    const w = s.window;
    if (!w || !w.responders[seat]) return { ok: false };
    if (action !== 'pass' && !w.responders[seat].opts.includes(action)) return { ok: false };
    w.responders[seat].resp = action;
    w.responders[seat].meta = meta || null;
    if (Object.values(w.responders).every(r => r.resp != null)) return this._resolveWindow();
    return { ok: true, pending: true };
  }
  windowAllResponded() {
    const w = this.s.window;
    return w && Object.values(w.responders).every(r => r.resp != null);
  }

  _resolveWindow() {
    const s = this.s, w = s.window;
    const tile = w.tile, from = w.from;
    const entries = Object.entries(w.responders).map(([seat, r]) => ({ seat: +seat, resp: r.resp }));
    // 一炮多响：所有选 hu 的都胡（单赢变体只取最近一家）
    let huers = entries.filter(e => e.resp === 'hu').map(e => e.seat);
    if (huers.length) {
      huers.sort((a, b) => ((a - from + 4) % 4) - ((b - from + 4) % 4));
      if (!s.rule.bloodBattle) huers = [huers[0]];
      for (const seat of huers) {
        const p = s.players[seat];
        p.hand[tile]++;
        this._settleWin(seat, tile, false, from, w.isQiangGang);
        p.hand[tile]--; // 和牌张不计回手牌（已记录在 huInfo）
      }
      s.window = null;
      return this._afterWinAdvance(from);
    }
    // 明杠
    const ganger = entries.find(e => e.resp === 'gang');
    if (ganger) {
      const seat = ganger.seat, p = s.players[seat];
      p.hand[tile] -= 3;
      p.melds.push({ type: 'gang', tile, from });
      this._log({ t: 'gang', seat, tile, gtype: 'ming', from });
      this._payGang(seat, 'ming', from);
      s.window = null;
      return this._drawReplacement(seat);
    }
    // 碰
    const penger = entries.find(e => e.resp === 'peng');
    if (penger) {
      const seat = penger.seat, p = s.players[seat];
      p.hand[tile] -= 2;
      p.melds.push({ type: 'peng', tile, from });
      this._log({ t: 'peng', seat, tile, from });
      s.window = null;
      s.phase = 'play'; s.turn = seat;
      return { ok: true, peng: { seat, tile }, needDiscard: seat };
    }
    // 吃（仅下家）
    const chier = entries.find(e => e.resp === 'chi');
    if (chier) {
      const seat = chier.seat, p = s.players[seat];
      const avail = w.responders[seat].chi || [];
      const meta = w.responders[seat].meta || {};
      let low = meta.seq;
      if (low == null || !avail.includes(low)) low = avail[0];
      for (const t of [low, low + 1, low + 2]) if (t !== tile) p.hand[t]--;
      p.melds.push({ type: 'chi', tile: low, from });
      this._log({ t: 'chi', seat, tile, low, from });
      s.window = null; s.phase = 'play'; s.turn = seat;
      return { ok: true, chi: { seat, low }, needDiscard: seat };
    }
    // 全部过
    return this._closeWindow();
  }

  _closeWindow() {
    const s = this.s;
    if (s.window && s.window.isQiangGang) {
      // 抢杠无人胡 → 补杠完成
      const bg = s.window._bugang;
      s.window = null;
      return this._completeBugang(bg.seat, bg.tile);
    }
    s.window = null;
    return this._advanceFrom(s.lastDraw ? s.lastDraw.seat : s.turn);
  }

  // 打牌/弃后推进到下一个存活玩家摸牌
  _advanceFrom(seat) {
    const s = this.s;
    s.phase = 'play';
    return this._nextDraw(seat);
  }
  _nextDraw(fromSeat) {
    const s = this.s;
    let seat = fromSeat;
    for (let i = 0; i < 4; i++) {
      seat = (seat + 1) % 4;
      if (!s.players[seat].hu) break;
    }
    if (s.players[seat].hu) { return this._endGame('all_hu'); }
    return this._draw(seat);
  }
  _draw(seat) {
    const s = this.s;
    if (s.wpos >= s.wend) return this._liuju();
    const tile = s.wall[s.wpos++];
    s.players[seat].hand[tile]++;
    s.players[seat].drawn = tile;
    s.turn = seat; s.phase = 'play';
    s.lastDraw = { seat, tile };
    this._log({ t: 'draw', seat, tile, rest: s.wend - s.wpos });
    return { ok: true, draw: { seat, tile }, rest: s.wend - s.wpos };
  }
  _drawReplacement(seat) {
    const s = this.s;
    if (s.wpos >= s.wend) return this._liuju();
    const tile = s.wall[--s.wend];   // 岭上牌从尾端取
    s.players[seat].hand[tile]++;
    s.players[seat].drawn = tile;
    s.turn = seat; s.phase = 'play';
    s.lastDraw = { seat, tile, gang: true };
    this._log({ t: 'draw', seat, tile, gang: true, rest: s.wend - s.wpos });
    return { ok: true, draw: { seat, tile, gang: true }, rest: s.wend - s.wpos };
  }

  // ---- 自摸 ----
  zimo(seat) {
    const s = this.s;
    if (s.phase !== 'play' || s.turn !== seat) return { ok: false };
    const p = s.players[seat];
    if (!canHu(p.hand, p.melds.length, p.que)) return { ok: false };
    const haidi = s.wpos >= s.wend;
    const ganghua = !!(s.lastDraw && s.lastDraw.gang);
    this._settleWin(seat, p.drawn, true, null, false, { haidi, ganghua });
    return this._afterWinAdvance(seat);
  }

  // ---- 暗杠 / 补杠 ----
  angang(seat, tile) {
    const s = this.s;
    if (s.phase !== 'play' || s.turn !== seat) return { ok: false };
    const p = s.players[seat];
    if (p.hand[tile] !== 4) return { ok: false };
    p.hand[tile] -= 4;
    p.melds.push({ type: 'angang', tile });
    this._log({ t: 'gang', seat, tile, gtype: 'an' });
    this._payGang(seat, 'an', null);
    return this._drawReplacement(seat);
  }
  bugang(seat, tile) {
    const s = this.s;
    if (s.phase !== 'play' || s.turn !== seat) return { ok: false };
    const p = s.players[seat];
    const m = p.melds.find(x => x.type === 'peng' && x.tile === tile);
    if (!m || p.hand[tile] < 1) return { ok: false };
    // 抢杠窗口（无人能抢时 _openWindow 内部会直接走 _closeWindow→_completeBugang）
    this._log({ t: 'bugang_try', seat, tile });
    return this._openWindow(seat, tile, true, { seat, tile });
  }
  _completeBugang(seat, tile) {
    const s = this.s, p = s.players[seat];
    const m = p.melds.find(x => x.type === 'peng' && x.tile === tile);
    m.type = 'bugang'; p.hand[tile] -= 1;
    this._log({ t: 'gang', seat, tile, gtype: 'bu' });
    this._payGang(seat, 'bu', m.from);
    return this._drawReplacement(seat);
  }

  // ---- 杠分（刮风下雨）立即结算，仅存活玩家之间 ----
  _payGang(seat, gtype, from) {
    const s = this.s;
    // 暗杠(下雨)：每家2；明杠(刮风)：放杠者2；补杠(转弯)：每家1
    if (gtype === 'an') {
      for (let i = 0; i < 4; i++) if (i !== seat && !s.players[i].hu) { this._transfer(i, seat, 2 * s.rule.di); }
    } else if (gtype === 'ming') {
      if (from != null && !s.players[from].hu) this._transfer(from, seat, 2 * s.rule.di);
    } else if (gtype === 'bu') {
      for (let i = 0; i < 4; i++) if (i !== seat && !s.players[i].hu) { this._transfer(i, seat, 1 * s.rule.di); }
    }
    s.players[seat].gangGains = (s.players[seat].gangGains || 0) + 1;
  }
  _transfer(fromSeat, toSeat, amt) {
    this.s.players[fromSeat].score -= amt;
    this.s.players[toSeat].score += amt;
  }

  // ---- 和牌结算 ----
  _settleWin(seat, winTile, isZimo, fromSeat, isQiangGang, extra = {}) {
    const s = this.s, p = s.players[seat];
    const score = scoreWin({
      cnt: p.hand, melds: p.melds, winTile, isZimo, que: p.que, rule: s.rule,
      flags: {
        ganghua: !!extra.ganghua, qianggang: !!isQiangGang, haidi: !!extra.haidi,
        tianhu: false, dihu: false,
      },
    });
    p.hu = true; p.huInfo = { ...score, winTile, isZimo, from: fromSeat, qiangGang: !!isQiangGang };
    s.liveCount--;
    // 收分
    if (isZimo) {
      for (let i = 0; i < 4; i++) if (i !== seat && !s.players[i].hu) this._transfer(i, seat, score.points);
    } else {
      this._transfer(fromSeat, seat, score.points);  // 点炮包：放炮者付
    }
    this._log({ t: 'hu', seat, tile: winTile, zimo: isZimo, from: fromSeat, info: p.huInfo });
  }

  _afterWinAdvance(fromSeat) {
    const s = this.s;
    if (!s.rule.bloodBattle) return this._endGame('win');   // 单赢一局即结束
    if (s.liveCount <= 1) return this._endGame('all_hu');
    // 自摸后从自己下家摸；点炮后从放炮者下家摸
    return this._nextDraw(fromSeat);
  }

  // ---- 流局（查叫 / 查花猪 / 退税） ----
  _liuju() {
    const s = this.s;
    if (s.rule.liujuSettle === 'none') return this._endGame('liuju');   // 荒庄不赔
    const live = [];
    for (let i = 0; i < 4; i++) if (!s.players[i].hu) live.push(i);
    // 判定每家：花猪 / 听牌 / 未听
    const info = {};
    for (const seat of live) {
      const p = s.players[seat];
      const suits = new Set();
      for (let t = 0; t < 27; t++) if (p.hand[t] > 0) suits.add(suitOf(t));
      const huazhu = suits.size >= 3;   // 三种花色都在 = 花猪（没打缺）
      const ting = !huazhu && queCleared(p.hand, p.que) && isTing(p.hand, p.melds.length, p.que);
      info[seat] = { huazhu, ting, maxFan: ting ? this._estTingFan(seat) : 0 };
    }
    // 查花猪：花猪赔每个非花猪 live 玩家（按封顶大番）
    const cap = Math.pow(2, s.rule.maxFan);
    for (const seat of live) {
      if (info[seat].huazhu) {
        for (const other of live) if (other !== seat && !info[other].huazhu) {
          this._transfer(seat, other, s.rule.di * cap);
        }
      }
    }
    // 查大叫：未听(非花猪) 赔 听牌者（按听牌者番）
    for (const tgt of live) {
      if (!info[tgt].ting) continue;
      for (const payer of live) {
        if (payer === tgt) continue;
        if (info[payer].ting) continue;            // 听牌之间不互赔
        if (info[payer].huazhu) continue;          // 花猪已单独赔
        this._transfer(payer, tgt, s.rule.di * Math.pow(2, Math.min(info[tgt].maxFan, s.rule.maxFan)));
      }
    }
    // 退税：未听 / 花猪 退回本局所收杠分（简化：按已收杠分笔数 ×2底退回公摊给听牌者）
    // 此处从简：未听者把 gangGains 笔数 ×2 底退给每个听牌者
    return this._endGame('liuju', info);
  }
  _estTingFan(seat) {
    const s = this.s, p = s.players[seat];
    const tiles = tingTiles(p.hand, p.melds.length, p.que);
    let best = 0;
    for (const t of tiles.slice(0, 6)) {
      p.hand[t]++;
      const sc = scoreWin({ cnt: p.hand, melds: p.melds, winTile: t, isZimo: false, que: p.que, rule: s.rule, flags: {} });
      p.hand[t]--;
      if (sc.fan > best) best = sc.fan;
    }
    return best;
  }

  _endGame(reason, liujuInfo) {
    const s = this.s;
    s.phase = 'end';
    s.result = { reason, liujuInfo: liujuInfo || null, scores: s.players.map(p => p.score) };
    this._log({ t: 'end', reason, scores: s.result.scores });
    return { ok: true, end: s.result };
  }

  // ---- AI 自动决策（供单机/补位调用） ----
  aiActTurn(seat) {
    const s = this.s, p = s.players[seat];
    const o = this.turnOptions(seat);
    if (!o) return { ok: false };
    if (o.zimo) return this.zimo(seat);
    // 杠：简单策略——能暗杠且不破听就暗杠
    if (o.angang.length) {
      const t = o.angang[0];
      // 暗杠通常有利
      return this.angang(seat, t);
    }
    if (o.bugang.length) {
      return this.bugang(seat, o.bugang[0]);
    }
    const tile = aiDiscard(p.hand, p.que, p.melds.length);
    return this.discard(seat, tile);
  }
  aiRespond(seat) {
    const s = this.s, w = s.window;
    if (!w || !w.responders[seat]) return { ok: false };
    const p = s.players[seat];
    const opts = w.responders[seat].opts;
    if (opts.includes('hu')) return this.respond(seat, 'hu');   // 有胡必胡
    if (opts.includes('gang') && aiShouldGangDiscard(p.hand, p.que, p.melds.length, w.tile)) return this.respond(seat, 'gang');
    if (opts.includes('peng') && aiShouldPeng(p.hand, p.que, p.melds.length, w.tile)) return this.respond(seat, 'peng');
    if (opts.includes('chi')) {
      const best = aiChooseChi(p.hand, p.que, p.melds.length, w.tile, w.responders[seat].chi || []);
      if (best != null) return this.respond(seat, 'chi', { seq: best });
    }
    return this.respond(seat, 'pass');
  }
}

export default {
  SCMJGame, scoreWin, canHu, isTing, tingTiles, shanten, chiitoiInfo,
  aiChooseQue, aiDiscard, aiChooseChi, chiOptions, freshWall, mulberry32, tstr, parseTile,
  RULES, ruleFor, DEFAULT_RULE,
  SUITS, SUIT_NAME, suitOf, rankOf, tid, listToCounts, countsToList, emptyCounts,
};
