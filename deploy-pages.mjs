// Cloudflare Pages 部署脚本（构建暂存目录 + 白名单复制）
//
// 为什么需要这个脚本：`wrangler pages deploy` 使用硬编码忽略列表
// （node_modules/.git/.wrangler/functions/_redirects/_headers/_routes.json/_worker.js），
// 不读取 .assetsignore —— 该文件仅对 Workers assets（非 Pages 直传）生效。
// 若直接部署项目根目录，server.mjs、data/（本地账号库）、日志、测试脚本、
// wrangler.toml 等本地文件都会被当作静态资源公开。
//
// 因此改为：先把明确允许公开的文件复制到 deploy-dist/，再部署该目录。
// 用法：node deploy-pages.mjs   （内部自动调用 `npx wrangler pages deploy`）
import { cpSync, rmSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, 'deploy-dist');

// 白名单：根目录文件
const ROOT_FILES = [
  'index.html',
  'player.html',
  'wd.html',
  'about.html',
  'manifest.json',
  'robots.txt',
  'service-worker.js',
  'bg-canvas.jpg',
  'bg-canvas.png',
  // Pages 平台配置（必须）
  '_headers',
  '_redirects',
  '_routes.json'
];

// 白名单：整目录复制（functions/ 不复制——wrangler 从项目根目录的 ./functions 读取）
const ROOT_DIRS = ['css', 'js', 'libs', 'image'];

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

for (const f of ROOT_FILES) {
  const src = join(root, f);
  if (!existsSync(src)) {
    console.warn(`[deploy] 警告：白名单文件不存在，跳过 ${f}`);
    continue;
  }
  cpSync(src, join(dist, f));
}

for (const d of ROOT_DIRS) {
  const src = join(root, d);
  if (!existsSync(src)) {
    console.warn(`[deploy] 警告：白名单目录不存在，跳过 ${d}/`);
    continue;
  }
  cpSync(src, join(dist, d), { recursive: true });
}

console.log('[deploy] deploy-dist 构建完成：');
for (const f of ROOT_FILES) if (existsSync(join(dist, f))) console.log(`  ${f}`);
for (const d of ROOT_DIRS) if (existsSync(join(dist, d))) console.log(`  ${d}/`);

if (process.argv.includes('--build-only')) {
  console.log('[deploy] --build-only：跳过上传');
  process.exit(0);
}

console.log('[deploy] 开始上传到 Cloudflare Pages ...');
const r = spawnSync('npx', ['wrangler', 'pages', 'deploy'], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32'
});
process.exit(r.status ?? 1);
