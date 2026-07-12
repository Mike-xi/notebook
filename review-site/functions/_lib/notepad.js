// 手写笔记共享工具：页面 JSON 的读取与资产 GC。
// 页面 JSON 结构：{ strokes: [...], items: [...] }，items 里 type='image' 的 src 是 R2 asset key。

// 纸张模板白名单（前端 drawPaper 与此同步）
export const PAPERS = ['blank', 'lined', 'grid', 'dotted', 'cornell'];

export function pageDataKey(owner, pageId) {
  return `notepad/${owner}/page-${pageId}.json`;
}

// 收集页面 JSON 里引用的本 owner 资产 key（防御式解析，坏数据直接忽略）
export function collectAssetKeys(data, owner) {
  const keys = [];
  const prefix = `notepad/${owner}/asset-`;
  for (const it of (Array.isArray(data?.items) ? data.items : [])) {
    if (it && it.type === 'image' && typeof it.src === 'string' && it.src.startsWith(prefix)) keys.push(it.src);
  }
  return keys;
}

// 删除一个页面对应的 R2 数据（页面 JSON + 引用的图片资产）。任何失败都吞掉，不阻塞删除主流程。
export async function deletePageBlobs(env, owner, pageId) {
  const key = pageDataKey(owner, pageId);
  try {
    const obj = await env.FILES.get(key);
    if (obj) {
      const data = await obj.json().catch(() => null);
      for (const k of collectAssetKeys(data, owner)) {
        try { await env.FILES.delete(k); } catch {}
      }
    }
  } catch {}
  try { await env.FILES.delete(key); } catch {}
}
