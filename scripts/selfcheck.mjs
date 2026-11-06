// WDTV deploy-dist 镜像自检
//
// 背景：deploy-pages.mjs 用白名单（ROOT_FILES 12 个 + ROOT_DIRS 4 个目录）构建 deploy-dist，
// 仓库里这份 dist 是已提交的静态副本，改根目录 css/js 后必须同步。历史上出现过「只剩 12 个
// 根文件、css/js/libs/image 四目录丢失」导致线上静态资源 404 的事故，也曾有 48 文件基线。
//
// 本脚本不写死文件数：新增 js/css 后 dist 文件数必然变化，正确判据是
//   「根目录白名单集合 == dist 集合，且逐文件字节一致」。48 只作为基线快照打印。
//
// 用法：node scripts/selfcheck.mjs

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const root = join(scriptsDir, '..');
const dist = join(root, 'deploy-dist');
const BASELINE_COUNT = 48;

// 与 deploy-pages.mjs 的 ROOT_FILES / ROOT_DIRS 保持一致；改动该脚本时这里也要同步
const ROOT_FILES = [
  'index.html', 'player.html', 'wd.html', 'about.html',
  'manifest.json', 'robots.txt', 'service-worker.js',
  'bg-canvas.jpg', 'bg-canvas.png',
  '_headers', '_redirects', '_routes.json'
];
const ROOT_DIRS = ['css', 'js', 'libs', 'image'];
const FORBIDDEN = [
  'server.mjs', 'package.json', 'package-lock.json', 'schema.sql', 'wrangler.toml',
  'deploy-pages.mjs', 'nodemon.json', '.env', '.env.example', 'README.md', 'LICENSE'
];
const FORBIDDEN_DIRS = ['data', 'test', 'scripts', 'functions', 'sync-worker', 'LibreTV', 'node_modules', '.git', '.wrangler'];

function walk(dir, base = dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, base, out);
    else out.push(relative(base, full).split(sep).join('/'));
  }
  return out;
}

function sameBytes(a, b) {
  try {
    return readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
}

function main() {
  const errors = [];
  const expected = new Set();

  for (const f of ROOT_FILES) expected.add(f);
  for (const d of ROOT_DIRS) {
    for (const f of walk(join(root, d), root)) expected.add(f);
  }
  const actual = new Set(walk(dist, dist));

  let same = 0;
  for (const f of expected) {
    if (!actual.has(f)) {
      errors.push(`MISSING  deploy-dist/${f}（根目录有，镜像缺）`);
    } else if (!sameBytes(join(root, f), join(dist, f))) {
      errors.push(`DIFF     deploy-dist/${f} 与根目录字节不一致`);
    } else {
      same++;
    }
  }
  for (const f of actual) {
    if (!expected.has(f)) errors.push(`EXTRA    deploy-dist/${f}（不在白名单内）`);
  }

  // 防泄露检查：这些文件/目录绝不能出现在 dist
  for (const f of FORBIDDEN) {
    if (actual.has(f)) errors.push(`FORBIDDEN deploy-dist/${f} 不应被公开`);
  }
  for (const d of FORBIDDEN_DIRS) {
    const rel = walk(join(dist, d), dist);
    if (rel.length) errors.push(`FORBIDDEN deploy-dist/${d}/ 目录（${rel.length} 个文件）不应被公开`);
  }

  console.log(`基线快照：${BASELINE_COUNT} 个文件（历史值，仅参考）`);
  console.log(`当前：根目录白名单 ${expected.size} 个，deploy-dist ${actual.size} 个，逐文件一致 ${same} 个`);
  if (errors.length === 0) {
    console.log('OK       集合相等且逐文件 cmp 全 SAME，无禁止公开的文件。');
    return 0;
  }
  for (const e of errors) console.log(e);
  console.log(`\n发现 ${errors.length} 个问题。修复：cp -f 白名单根文件 + cp -R css js libs image deploy-dist/`);
  return 1;
}

process.exit(main());
