// RAG 共享逻辑：模型常量、rag_index 表、分块、嵌入。
export const EMBED_MODEL = '@cf/baai/bge-m3';                       // 1024 维，多语言（中文友好）

// 对话可选模型：白名单 + 单一数据源（前端下拉与后端校验都用它，避免两处写死跑偏）。
// 第一个为默认。仅保留 Workers AI 当前在售、未弃用的模型 ID。
export const CHAT_MODELS = [
  { id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',    label: 'Llama 3.3 70B', hint: '均衡 · 默认' },
  { id: '@cf/qwen/qwen1.5-14b-chat-awq',               label: 'Qwen 1.5 14B',  hint: '中文流畅' },
  { id: '@cf/meta/llama-3.1-8b-instruct',              label: 'Llama 3.1 8B',  hint: '轻快' },
  { id: '@cf/google/gemma-4-26b-a4b-it',               label: 'Gemma 4 26B',   hint: '较新' },
  { id: '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b', label: 'DeepSeek R1',  hint: '深度思考' },
];
export const CHAT_MODEL = CHAT_MODELS[0].id;
const CHAT_MODEL_IDS = new Set(CHAT_MODELS.map((m) => m.id));

// 把客户端传来的模型 ID 收敛到白名单内，非法/缺省一律回退默认，避免乱调模型。
export function resolveChatModel(id) {
  return CHAT_MODEL_IDS.has(String(id || '')) ? String(id) : CHAT_MODEL;
}

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v)).trim();

let ragReady = false;
export async function ensureRagSchema(env) {
  if (ragReady) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS rag_index (
       file       TEXT PRIMARY KEY,
       hash       TEXT NOT NULL,
       chunks     INTEGER NOT NULL DEFAULT 0,
       updated_at INTEGER NOT NULL
     )`
  ).run();
  ragReady = true;
}

// sections [{heading, level, text}] -> chunks [{heading, text}]，按句子边界切，限制总块数控成本
export function chunkSections(sections, { maxChars = 700, maxChunks = 120 } = {}) {
  const chunks = [];
  for (const s of sections || []) {
    const heading = str(s && s.heading) || '正文';
    const text = str(s && s.text);
    if (!text) continue;
    for (const piece of splitText(text, maxChars)) {
      chunks.push({ heading, text: piece });
      if (chunks.length >= maxChunks) return chunks;
    }
  }
  return chunks;
}

function splitText(text, maxChars) {
  const t = String(text).replace(/\s+/g, ' ').trim();
  if (t.length <= maxChars) return t ? [t] : [];
  const out = [];
  const sentences = t.split(/(?<=[。！？.!?；;])\s*/);
  let buf = '';
  for (const sen of sentences) {
    if ((buf + sen).length > maxChars && buf) { out.push(buf.trim()); buf = ''; }
    if (sen.length > maxChars) {
      for (let i = 0; i < sen.length; i += maxChars) out.push(sen.slice(i, i + maxChars));
    } else {
      buf += sen;
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out.filter(Boolean);
}

// 批量嵌入，返回 [[...1024], ...]
export async function embed(env, texts) {
  const r = await env.AI.run(EMBED_MODEL, { text: texts });
  return (r && (r.data ?? r.result?.data)) || [];
}

// 向量 id：文件名 sanitize + 序号（用于 upsert / 按序删除旧向量）
export function vecId(file, idx) {
  return String(file).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48) + '_' + idx;
}
