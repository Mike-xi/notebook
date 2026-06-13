// 五子棋「Workers AI 对手」：让所选 Workers AI 模型给出落子，配服务端战术守门
// （能赢就赢、对手能成五就堵）+ 启发式兜底，保证返回的永远是合法且不弱智的一手。
//   GET  /api/gomoku-ai                              -> { models:[{id,label,hint}] }
//   POST /api/gomoku-ai {moves,size,ai,difficulty,model} -> { x, y, source }
// ai = 要落子的颜色(1黑/2白)；difficulty = easy|medium|hard；moves = [[x,y,c],...]
// 鉴权由 _middleware.js 处理。无 AI 绑定时优雅降级为纯启发式。
const json = (o, s = 200) => Response.json(o, { status: s });

const MODELS = [
  { id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', label: 'Llama 3.3 70B', hint: '强 · 默认' },
  { id: '@cf/qwen/qwen2.5-coder-32b-instruct', label: 'Qwen2.5 Coder 32B', hint: '推理型' },
  { id: '@cf/mistralai/mistral-small-3.1-24b-instruct', label: 'Mistral Small 24B', hint: '均衡' },
  { id: '@cf/meta/llama-3.1-8b-instruct', label: 'Llama 3.1 8B', hint: '快' },
];
const MODEL_IDS = new Set(MODELS.map((m) => m.id));

export function onRequestGet() { return json({ models: MODELS }); }

// ---------- 棋形/启发式（服务端紧凑版，思路同 lihongxun945/gobang 的形分） ----------
function buildBoard(moves, size) {
  const b = Array.from({ length: size }, () => new Array(size).fill(0));
  for (const m of (moves || [])) { const [x, y, c] = m; if (x >= 0 && y >= 0 && x < size && y < size) b[y][x] = c; }
  return b;
}
const DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];

// 在 (x,y) 落 color 后，该点 4 方向的形分之和（用于进攻；对手色用于防守）
function pointScore(board, size, x, y, color) {
  let total = 0;
  for (const [dx, dy] of DIRS) {
    let count = 1, blocks = 0;
    for (let s = 1; s < 5; s++) { const nx = x + dx * s, ny = y + dy * s; if (nx < 0 || ny < 0 || nx >= size || ny >= size) { blocks++; break; } const v = board[ny][nx]; if (v === color) count++; else { if (v !== 0) blocks++; break; } }
    for (let s = 1; s < 5; s++) { const nx = x - dx * s, ny = y - dy * s; if (nx < 0 || ny < 0 || nx >= size || ny >= size) { blocks++; break; } const v = board[ny][nx]; if (v === color) count++; else { if (v !== 0) blocks++; break; } }
    total += shape(count, blocks);
  }
  return total;
}
function shape(count, blocks) {
  if (count >= 5) return 100000;
  if (blocks === 2) return count >= 4 ? 10 : 0;          // 两端都堵，几乎无用
  if (count === 4) return blocks === 0 ? 12000 : 1500;   // 活四 / 冲四
  if (count === 3) return blocks === 0 ? 1200 : 120;     // 活三 / 眠三
  if (count === 2) return blocks === 0 ? 120 : 15;
  if (count === 1) return blocks === 0 ? 12 : 2;
  return 0;
}
function candidates(board, size) {
  const out = [];
  const seen = new Set();
  let any = false;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (board[y][x]) {
    any = true;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= size || ny >= size || board[ny][nx]) continue;
      const k = ny * size + nx; if (!seen.has(k)) { seen.add(k); out.push([nx, ny]); }
    }
  }
  if (!any) { const c = size >> 1; return [[c, c]]; }
  return out;
}
function wins(board, size, x, y, color) {
  for (const [dx, dy] of DIRS) {
    let n = 1;
    for (let s = 1; s < 5; s++) { const nx = x + dx * s, ny = y + dy * s; if (nx < 0 || ny < 0 || nx >= size || ny >= size || board[ny][nx] !== color) break; n++; }
    for (let s = 1; s < 5; s++) { const nx = x - dx * s, ny = y - dy * s; if (nx < 0 || ny < 0 || nx >= size || ny >= size || board[ny][nx] !== color) break; n++; }
    if (n >= 5) return true;
  }
  return false;
}
function findWinningMove(board, size, cands, color) {
  for (const [x, y] of cands) { board[y][x] = color; const w = wins(board, size, x, y, color); board[y][x] = 0; if (w) return [x, y]; }
  return null;
}
function heuristicBest(board, size, cands, ai, opp) {
  let best = cands[0], bestScore = -1;
  for (const [x, y] of cands) {
    const s = pointScore(board, size, x, y, ai) + 0.95 * pointScore(board, size, x, y, opp);
    if (s > bestScore) { bestScore = s; best = [x, y]; }
  }
  return best;
}

function boardText(board, size) {
  // 列标 0..size-1（两位），行用 .=空 X=黑 O=白
  let s = '   ' + Array.from({ length: size }, (_, i) => String(i).padStart(2, ' ')).join('') + '\n';
  for (let y = 0; y < size; y++) {
    s += String(y).padStart(2, ' ') + ' ';
    for (let x = 0; x < size; x++) s += ' ' + (board[y][x] === 1 ? 'X' : board[y][x] === 2 ? 'O' : '.');
    s += '\n';
  }
  return s;
}

async function askModel(env, model, board, size, ai) {
  const me = ai === 1 ? 'X (black)' : 'O (white)';
  const opp = ai === 1 ? 'O (white)' : 'X (black)';
  const prompt =
    `You are an expert Gomoku (five-in-a-row, ${size}x${size}) player. You play ${me}; opponent is ${opp}. ` +
    `Coordinates are (col x, row y), both 0-indexed from top-left. Empty cells are '.'.\n` +
    `Board:\n${boardText(board, size)}\n` +
    `Choose the single best legal move for ${me} on an empty cell. ` +
    `Win by getting five in a row; block the opponent if they are about to. ` +
    `Reply with ONLY JSON: {"x": <col>, "y": <row>}. No other text.`;
  const r = await env.AI.run(model, {
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.4, max_tokens: 60,
  });
  const txt = (r && (r.response || r.result || '')) + '';
  const m = txt.match(/"?x"?\s*[:=]\s*(\d+)[\s,}]+.*?"?y"?\s*[:=]\s*(\d+)/s) || txt.match(/\(?\s*(\d+)\s*,\s*(\d+)\s*\)?/);
  if (!m) return null;
  return [parseInt(m[1], 10), parseInt(m[2], 10)];
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
  const size = Math.min(Math.max(body?.size | 0 || 15, 5), 19);
  const ai = body?.ai === 2 ? 2 : 1;
  const opp = ai === 1 ? 2 : 1;
  const difficulty = ['easy', 'medium', 'hard'].includes(body?.difficulty) ? body.difficulty : 'medium';
  const board = buildBoard(body?.moves, size);
  const cands = candidates(board, size);
  if (!cands.length) return json({ error: 'no moves' }, 400);

  // 战术守门：能赢就赢；对手能成五就堵（easy 难度跳过堵棋，让它会输）
  const win = findWinningMove(board, size, cands, ai);
  if (win) return json({ x: win[0], y: win[1], source: 'win' });
  if (difficulty !== 'easy') {
    const block = findWinningMove(board, size, cands, opp);
    if (block) return json({ x: block[0], y: block[1], source: 'block' });
  }

  // 让所选模型决策；非法/超时则启发式兜底。hard 难度直接用启发式（更稳）。
  const model = MODEL_IDS.has(body?.model) ? body.model : MODELS[0].id;
  if (difficulty !== 'hard' && env && env.AI) {
    try {
      const mv = await askModel(env, model, board, size, ai);
      if (mv && mv[0] >= 0 && mv[1] >= 0 && mv[0] < size && mv[1] < size && board[mv[1]][mv[0]] === 0) {
        return json({ x: mv[0], y: mv[1], source: 'ai' });
      }
    } catch (e) { /* 降级到启发式 */ }
  }
  const best = heuristicBest(board, size, cands, ai, opp);
  return json({ x: best[0], y: best[1], source: 'heuristic' });
}
