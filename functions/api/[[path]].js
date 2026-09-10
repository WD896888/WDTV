// 账号系统 API 入口（Pages Functions 文件路由 /api/*）
// 核心逻辑在 _lib.mjs：与本地 server.mjs 开发服、test-sync.mjs 测试共用同一实现
import { handleApi } from './_lib.mjs';

export async function onRequest(context) {
    return handleApi(context.request, context.env);
}
