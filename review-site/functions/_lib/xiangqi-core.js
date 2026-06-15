// 中国象棋规则引擎（client 与 server 共用，纯函数、无依赖）。
// 坐标：row 0 在最上方（黑方底线），row 9 在最下方（红方底线）；col 0..8 从左到右。
// 红(r)向上走(row 递减)，黑(b)向下走(row 递增)。河界在 row4 与 row5 之间。
// 棋子 t: K将帅 A士仕 B象相 N马 R车 C炮 P兵卒。color c: 'r'红 / 'b'黑。
// 棋盘：长度 90 的一维数组，idx(r,c)=r*9+c，每格 null 或 {c,t}。

export const COLS = 9, ROWS = 10;
export const idx = (r, c) => r * COLS + c;
export const inBounds = (r, c) => r >= 0 && r < ROWS && c >= 0 && c < COLS;
export const enemy = (color) => (color === 'r' ? 'b' : 'r');
export const cloneBoard = (b) => b.slice();
const get = (b, r, c) => (inBounds(r, c) ? b[idx(r, c)] : undefined);

// 初始局面
export function initialBoard() {
  const b = new Array(90).fill(null);
  const back = ['R', 'N', 'B', 'A', 'K', 'A', 'B', 'N', 'R'];
  for (let c = 0; c < 9; c++) { b[idx(0, c)] = { c: 'b', t: back[c] }; b[idx(9, c)] = { c: 'r', t: back[c] }; }
  b[idx(2, 1)] = { c: 'b', t: 'C' }; b[idx(2, 7)] = { c: 'b', t: 'C' };
  b[idx(7, 1)] = { c: 'r', t: 'C' }; b[idx(7, 7)] = { c: 'r', t: 'C' };
  for (const c of [0, 2, 4, 6, 8]) { b[idx(3, c)] = { c: 'b', t: 'P' }; b[idx(6, c)] = { c: 'r', t: 'P' }; }
  return b;
}
export function initialState() { return { board: initialBoard(), turn: 'r' }; }

// 九宫范围
const inPalace = (color, r, c) => {
  if (c < 3 || c > 5) return false;
  return color === 'r' ? (r >= 7 && r <= 9) : (r >= 0 && r <= 2);
};
// 是否在自己半场（象不能过河）
const ownSide = (color, r) => (color === 'r' ? r >= 5 : r <= 4);
// 兵是否已过河
const pawnCrossed = (color, r) => (color === 'r' ? r <= 4 : r >= 5);

export function generalPos(b, color) {
  for (let i = 0; i < 90; i++) { const p = b[i]; if (p && p.c === color && p.t === 'K') return [Math.floor(i / 9), i % 9]; }
  return null;
}

// (tr,tc) 是否被 byColor 的子攻击（只考虑能将军的子：车 R / 炮 C / 马 N / 兵 P）。
export function attackedBy(b, tr, tc, byColor) {
  const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  // 车 / 炮：沿四方向扫描，记录遇到的第一、第二个子
  for (const [dr, dc] of dirs) {
    let r = tr + dr, c = tc + dc, seen = 0, screen = null;
    while (inBounds(r, c)) {
      const p = b[idx(r, c)];
      if (p) {
        seen++;
        if (seen === 1) { // 第一个子：车直接攻击
          if (p.c === byColor && p.t === 'R') return true;
          screen = p;
        } else if (seen === 2) { // 第二个子：炮隔山攻击
          if (p.c === byColor && p.t === 'C') return true;
          break;
        }
      }
      r += dr; c += dc;
    }
  }
  // 马（蹩马腿）：candidate 马位置 = target - delta
  const km = [[-2, -1], [-2, 1], [2, -1], [2, 1], [-1, -2], [1, -2], [-1, 2], [1, 2]];
  for (const [dr, dc] of km) {
    const kr = tr - dr, kc = tc - dc;
    const p = get(b, kr, kc);
    if (p && p.c === byColor && p.t === 'N') {
      // 马腿：从马位置朝目标的“长边”方向第一格
      const legR = kr + (Math.abs(dr) === 2 ? dr / 2 : 0);
      const legC = kc + (Math.abs(dc) === 2 ? dc / 2 : 0);
      if (!b[idx(legR, legC)]) return true;
    }
  }
  // 兵/卒
  if (byColor === 'r') { // 红兵向上(row 递减)，攻击其上方；过河后也攻击左右
    let p = get(b, tr + 1, tc); if (p && p.c === 'r' && p.t === 'P') return true; // 红兵在下方，向上攻到 target
    if (tr <= 4) { for (const dc of [-1, 1]) { p = get(b, tr, tc + dc); if (p && p.c === 'r' && p.t === 'P') return true; } }
  } else { // 黑卒向下(row 递增)
    let p = get(b, tr - 1, tc); if (p && p.c === 'b' && p.t === 'P') return true;
    if (tr >= 5) { for (const dc of [-1, 1]) { p = get(b, tr, tc + dc); if (p && p.c === 'b' && p.t === 'P') return true; } }
  }
  return false;
}

// color 一方是否被将军（含“将帅照面”飞将）
export function inCheck(b, color) {
  const gp = generalPos(b, color);
  if (!gp) return true; // 将被吃 = 视为已死/非法
  // 飞将：两将同列且中间无子
  const og = generalPos(b, enemy(color));
  if (og && og[1] === gp[1]) {
    const c = gp[1]; const lo = Math.min(gp[0], og[0]) + 1, hi = Math.max(gp[0], og[0]);
    let blocked = false;
    for (let r = lo; r < hi; r++) if (b[idx(r, c)]) { blocked = true; break; }
    if (!blocked) return true;
  }
  return attackedBy(b, gp[0], gp[1], enemy(color));
}

// 单子伪合法落点（不含“是否送将”过滤），返回 [[tr,tc],...]
export function pieceMoves(b, r, c) {
  const p = b[idx(r, c)]; if (!p) return [];
  const color = p.c, out = [];
  const canLand = (tr, tc) => { if (!inBounds(tr, tc)) return false; const q = b[idx(tr, tc)]; return !q || q.c !== color; };
  switch (p.t) {
    case 'K': {
      for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) { const tr = r + dr, tc = c + dc; if (inPalace(color, tr, tc) && canLand(tr, tc)) out.push([tr, tc]); }
      break;
    }
    case 'A': {
      for (const [dr, dc] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) { const tr = r + dr, tc = c + dc; if (inPalace(color, tr, tc) && canLand(tr, tc)) out.push([tr, tc]); }
      break;
    }
    case 'B': {
      for (const [dr, dc] of [[-2, -2], [-2, 2], [2, -2], [2, 2]]) {
        const tr = r + dr, tc = c + dc; if (!inBounds(tr, tc) || !ownSide(color, tr)) continue;
        if (b[idx(r + dr / 2, c + dc / 2)]) continue; // 塞象眼
        if (canLand(tr, tc)) out.push([tr, tc]);
      }
      break;
    }
    case 'N': {
      const moves = [[-2, -1], [-2, 1], [2, -1], [2, 1], [-1, -2], [1, -2], [-1, 2], [1, 2]];
      for (const [dr, dc] of moves) {
        const tr = r + dr, tc = c + dc; if (!canLand(tr, tc)) continue;
        const legR = r + (Math.abs(dr) === 2 ? dr / 2 : 0), legC = c + (Math.abs(dc) === 2 ? dc / 2 : 0);
        if (b[idx(legR, legC)]) continue; // 蹩马腿
        out.push([tr, tc]);
      }
      break;
    }
    case 'R': {
      for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        let tr = r + dr, tc = c + dc;
        while (inBounds(tr, tc)) { const q = b[idx(tr, tc)]; if (!q) out.push([tr, tc]); else { if (q.c !== color) out.push([tr, tc]); break; } tr += dr; tc += dc; }
      }
      break;
    }
    case 'C': {
      for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        let tr = r + dr, tc = c + dc, jumped = false;
        while (inBounds(tr, tc)) {
          const q = b[idx(tr, tc)];
          if (!jumped) { if (!q) out.push([tr, tc]); else jumped = true; }
          else { if (q) { if (q.c !== color) out.push([tr, tc]); break; } }
          tr += dr; tc += dc;
        }
      }
      break;
    }
    case 'P': {
      const fwd = color === 'r' ? -1 : 1;
      if (canLand(r + fwd, c)) out.push([r + fwd, c]);
      if (pawnCrossed(color, r)) { for (const dc of [-1, 1]) if (canLand(r, c + dc)) out.push([r, c + dc]); }
      break;
    }
  }
  return out;
}

// 落子（返回新 state，turn 翻转）。move=[fr,fc,tr,tc]
export function applyMove(state, mv) {
  const b = cloneBoard(state.board);
  const [fr, fc, tr, tc] = mv;
  b[idx(tr, tc)] = b[idx(fr, fc)];
  b[idx(fr, fc)] = null;
  return { board: b, turn: enemy(state.turn) };
}

// 一步是否会让自己被将（含飞将）
function leavesInCheck(b, mv, color) {
  const nb = cloneBoard(b);
  const [fr, fc, tr, tc] = mv;
  nb[idx(tr, tc)] = nb[idx(fr, fc)]; nb[idx(fr, fc)] = null;
  return inCheck(nb, color);
}

// 当前行动方所有合法着法（已过滤送将/飞将）。返回 [[fr,fc,tr,tc,captured?],...]
export function legalMoves(state) {
  const b = state.board, color = state.turn, out = [];
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    const p = b[idx(r, c)]; if (!p || p.c !== color) continue;
    for (const [tr, tc] of pieceMoves(b, r, c)) {
      const mv = [r, c, tr, tc];
      if (!leavesInCheck(b, mv, color)) { const cap = b[idx(tr, tc)]; out.push(cap ? [r, c, tr, tc, cap.t] : [r, c, tr, tc]); }
    }
  }
  return out;
}

// 某一步是否合法（服务端校验用）
export function isLegalMove(state, mv) {
  const [fr, fc] = mv; const p = state.board[idx(fr, fc)];
  if (!p || p.c !== state.turn) return false;
  const dests = pieceMoves(state.board, fr, fc);
  if (!dests.some(([tr, tc]) => tr === mv[2] && tc === mv[3])) return false;
  return !leavesInCheck(state.board, mv, state.turn);
}

// 行动方是否无棋可走（将死或困毙，均判该方负）
export function noLegalMoves(state) { return legalMoves(state).length === 0; }
export const inCheckState = (state) => inCheck(state.board, state.turn);

// 终局：返回 null（未结束）/ 'r'胜 / 'b'胜 / 'draw'
export function outcome(state) {
  if (!generalPos(state.board, 'r')) return 'b';
  if (!generalPos(state.board, 'b')) return 'r';
  if (noLegalMoves(state)) return enemy(state.turn); // 走不了的一方负
  return null;
}

// ---------------- 评估（供 AI），从红方视角，正=红优 ----------------
const VAL = { K: 100000, R: 900, C: 450, N: 400, B: 200, A: 200, P: 100 };
// 兵的位置价值（红方视角，row 0..9）：过河、靠近敌方九宫更值钱
const PAWN_PST_R = [
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [90, 90, 110, 120, 120, 120, 110, 90, 90],
  [90, 90, 110, 120, 120, 120, 110, 90, 90],
  [70, 0, 80, 0, 90, 0, 80, 0, 70],
  [40, 0, 50, 0, 60, 0, 50, 0, 40],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
];
const HORSE_PST_R = [
  [4, 8, 16, 12, 4, 12, 16, 8, 4],
  [4, 10, 28, 16, 8, 16, 28, 10, 4],
  [12, 14, 16, 20, 18, 20, 16, 14, 12],
  [8, 24, 18, 24, 20, 24, 18, 24, 8],
  [6, 16, 14, 18, 16, 18, 14, 16, 6],
  [4, 12, 16, 14, 12, 14, 16, 12, 4],
  [2, 6, 8, 6, 10, 6, 8, 6, 2],
  [4, 2, 8, 8, 4, 8, 8, 2, 4],
  [0, 2, 4, 4, -2, 4, 4, 2, 0],
  [0, -4, 0, 0, 0, 0, 0, -4, 0],
];
const mirror = (r) => ROWS - 1 - r;
export function evaluate(state) {
  const b = state.board; let score = 0;
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    const p = b[idx(r, c)]; if (!p) continue;
    let v = VAL[p.t];
    if (p.t === 'P') v += (p.c === 'r' ? PAWN_PST_R[r][c] : PAWN_PST_R[mirror(r)][c]) - 100 + 0;
    else if (p.t === 'N') v += (p.c === 'r' ? HORSE_PST_R[r][c] : HORSE_PST_R[mirror(r)][c]);
    score += (p.c === 'r' ? v : -v);
  }
  return score; // 红视角
}

// 着法字符串（用于去重/调试）
export const moveStr = (mv) => `${mv[0]}${mv[1]}-${mv[2]}${mv[3]}`;
