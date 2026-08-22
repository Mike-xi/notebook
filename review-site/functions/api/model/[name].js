// GET /api/model/<name>  ->  从 R2 里吐出 ONNX 权重
//
// 为什么不放 /assets/ 当静态文件：**Cloudflare Pages 单文件上限 25 MiB**，
// MI-GAN 那份是 28 MB，塞不进去；而且这种大件也不该进 git。
// 为什么不让前端直连 HuggingFace：站点用户主要在国内，HF 直连不稳，
// 而 R2 走 Cloudflare 边缘，顺带还省掉一次跨域。
//
// 上传方式（一次性）：
//   npx wrangler r2 object put cloudflare/models/migan_pipeline_v2.onnx \
//       --file migan.onnx --content-type application/octet-stream --remote
//
// 鉴权由 _middleware.js 统一处理（/api/* 都要登录）。前端另外把权重存进 IndexedDB，
// 所以正常情况下每台设备只会真正下载一次。
const MODELS = {
  // 名字写死成白名单，别让路径参数直接拼进 R2 的 key —— 那等于把整个桶开放出去
  migan: {
    key: 'models/migan_pipeline_v2.onnx',
    type: 'application/octet-stream',
    // HuggingFace andraniksargsyan/migan 上游的 sha256，前端校验完整性用
    sha256: '6f1f3530a1a2324b19752018ce756088b07973cda8d7d890034ace5c8a48c40b',
    bytes: 28079181,
  },
};

export async function onRequestGet({ params, env, request }) {
  const meta = MODELS[String(params.name || '').replace(/\.onnx$/, '')];
  if (!meta) return new Response('未知模型', { status: 404 });
  if (!env.FILES) return new Response('R2 未绑定', { status: 503 });

  const obj = await env.FILES.get(meta.key, {
    // 支持断点续传：28MB 在弱网上很容易断，浏览器 fetch 失败后能靠 Range 续
    range: request.headers.get('Range') ? request : undefined,
  });
  if (!obj) return new Response('模型不在桶里，先按注释里的命令上传', { status: 404 });

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('Content-Type', meta.type);
  headers.set('ETag', obj.httpEtag);
  // 权重是不可变内容，放心让浏览器和边缘长期缓存
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  headers.set('X-Model-Sha256', meta.sha256);
  headers.set('X-Model-Bytes', String(meta.bytes));
  if (obj.range) {
    headers.set('Content-Range', `bytes ${obj.range.offset}-${obj.range.offset + obj.range.length - 1}/${meta.bytes}`);
    return new Response(obj.body, { status: 206, headers });
  }
  return new Response(obj.body, { headers });
}

// 前端先 HEAD 一下拿大小和哈希，好在下载前告诉用户「要下 28MB」
export async function onRequestHead({ params, env }) {
  const meta = MODELS[String(params.name || '').replace(/\.onnx$/, '')];
  if (!meta) return new Response(null, { status: 404 });
  return new Response(null, {
    headers: {
      'Content-Length': String(meta.bytes),
      'X-Model-Sha256': meta.sha256,
      'X-Model-Bytes': String(meta.bytes),
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}
