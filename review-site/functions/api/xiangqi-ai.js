// 象棋「关键步点评」接口（Workers AI）。纯文字点评，绝不参与决定走子（走子全靠本地引擎）。
//   GET  /api/xiangqi-ai                 -> { models }
//   POST /api/xiangqi-ai {kind, board, turn, lastMove, model, why}
//        kind='move' -> 对刚走的一步做简短中文点评； kind='over' -> 终局一句话总结
// 鉴权由 _middleware.js 处理。无 AI 绑定时返回空文本（前端会隐藏点评）。
import { idx, inCheck } from '../_lib/xiangqi-core.js';

const MODELS = [
  { id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', label: 'Llama 3.3 70B', hint: '强 · 默认' },
  { id: '@cf/qwen/qwen2.5-coder-32b-instruct', label: 'Qwen2.5 32B', hint: '推理型' },
  { id: '@cf/mistralai/mistral-small-3.1-24b-instruct', label: 'Mistral Small 24B', hint: '均衡' },
  { id: '@cf/meta/llama-3.1-8b-instruct', label: 'Llama 3.1 8B', hint: '快' },
];
const MODEL_IDS = new Set(MODELS.map((m) => m.id));
const resolveModel = (m) => (MODEL_IDS.has(m) ? m : MODELS[0].id);
const CH = { r: { K: '帅', A: '仕', B: '相', N: '马', R: '车', C: '炮', P: '兵' }, b: { K: '将', A: '士', B: '象', N: '马', R: '车', C: '炮', P: '卒' } };
const VAL = { K: 0, R: 9, C: 4.5, N: 4, B: 2, A: 2, P: 1 };

const json = (o, s = 200) => Response.json(o, { status: s });

export function onRequestGet() { return json({ models: MODELS }); }

function material(board) {
  let r = 0, b = 0;
  for (const p of board) { if (!p) continue; const v = VAL[p.t] || 0; if (p.c === 'r') r += v; else b += v; }
  return r - b; // 正=红子力领先
}
function cleanText(t) {
  if (!t) return '';
  t = ('' + t).replace(/[\x00-\x1f\x7f]/g, ' ').replace(/```[a-z]*/gi, '').replace(/^["'「『\s]+/, '').replace(/["'」』\s]+$/, '').replace(/\s+/g, ' ').trim();
  return t.slice(0, 80);
}

export async function onRequestPost({ request, env }) {
  let body; try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
  const board = Array.isArray(body?.board) && body.board.length === 90 ? body.board : null;
  if (!board) return json({ error: 'bad board' }, 400);
  if (!env || !env.AI) return json({ text: '' });

  const turn = body.turn === 'b' ? 'b' : 'r';      // 当前轮到谁
  const mover = turn === 'r' ? 'b' : 'r';            // 刚走子的是对方
  const mat = material(board);
  const lead = Math.abs(mat) < 1 ? '双方子力均势' : ((mat > 0 ? '红方' : '黑方') + '子力领先约' + Math.abs(mat).toFixed(1) + '分');
  const checking = inCheck(board, turn);

  let moverPiece = '';
  const lm = Array.isArray(body.lastMove) ? body.lastMove : null;
  if (lm && lm.length >= 4) { const p = board[idx(lm[2] | 0, lm[3] | 0)]; if (p) moverPiece = (p.c === 'r' ? '红' : '黑') + CH[p.c][p.t]; }

  let prompt;
  if (body.kind === 'over') {
    const why = body.why === '困毙' ? '困毙（无棋可走）' : '将死';
    const winner = turn === 'r' ? '黑方' : '红方'; // 轮到的一方无棋可走 → 对方胜
    prompt = `你是中国象棋解说。本局结束：${winner}${why==='将死'?'将死对方':'把对方逼成困毙'}获胜。用一句话（不超过30字）做个利落的终局总结，口语化，别长篇。`;
  } else {
    prompt = `你是中国象棋解说。刚才${moverPiece ? moverPiece + '走了一步' : (mover === 'r' ? '红方' : '黑方') + '走了一步'}。当前轮到${turn === 'r' ? '红方' : '黑方'}${checking ? '，而且正被将军！' : '。'}局面：${lead}。请用一句话（不超过30字）做简短点评或提醒，像棋友在旁边解说，口语化，不要复述规则、不要长篇、只输出这句话。`;
  }

  try {
    const r = await env.AI.run(resolveModel(body.model), { messages: [{ role: 'user', content: prompt }], temperature: 0.85, max_tokens: 90 });
    const resp = r && (r.response !== undefined ? r.response : r.result);
    const text = cleanText(typeof resp === 'object' && resp ? (resp.text || resp.say || JSON.stringify(resp)) : resp);
    return json({ text });
  } catch (e) { return json({ text: '' }); }
}
