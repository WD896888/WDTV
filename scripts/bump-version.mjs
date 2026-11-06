// WDTV 静态资源版本号单一来源工具
//
// 背景：项目带 Service Worker，静态资源走 Stale-While-Revalidate，同一个 ?v=N 网址会持续
// 返回缓存旧文件。因此改 css/js 后必须升 ?v=，并同步 SW changelog / CACHE_VERSION。
// 历史上 5 套版本号各自手工维护，出现过 4 处跨页漂移与 changelog 到 v62 而 CACHE_VERSION
// 停在 v55 的情况，本脚本把 ?v= 与 CACHE_VERSION 收敛到 scripts/version-map.json。
//
// 用法（在仓库根目录执行）：
//   node scripts/bump-version.mjs check                    只校验，不改文件
//   node scripts/bump-version.mjs bump js/app.js css/index.css   升指定资源版本并自动 sync
//   node scripts/bump-version.mjs sync                    把 map 写回 4 个 HTML 与 SW
//   node scripts/bump-version.mjs changelog "改动说明"     追加 SW changelog 条目并对齐缓存版本
//
// 注意：无 ?v= 的 libs/* 等资源（1 年 immutable）不在本脚本管理范围，见 map.unversioned。

import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const root = join(scriptsDir, '..');
const mapPath = join(scriptsDir, 'version-map.json');
const HTML_FILES = ['index.html', 'player.html', 'about.html', 'wd.html'];
const REF_RE = /(src|href)="([^"?#]+)\?v=\d+"/g;

function readMap() {
  return JSON.parse(readFileSync(mapPath, 'utf8'));
}
function writeMap(map) {
  writeFileSync(mapPath, JSON.stringify(map, null, 2) + '\n', 'utf8');
}
function p(rel) {
  return join(root, rel);
}
function today() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const DIST_DIR = join(root, 'deploy-dist');

// sync/changelog 写回根目录后，把被改动的根文件镜像到 deploy-dist 同名路径。
// selfcheck.mjs 的判据是「根白名单集合 == dist 集合且逐文件 cmp SAME」，只写根目录会让发版 DIFF。
// 仅复制根级 HTML/SW（HTML_FILES + service-worker.js），不复制整目录、不碰 version-map.json，
// 也不触碰 deploy-dist/js|css|libs|image。目标目录存在才写。
function mirrorToDist(rels) {
  if (!existsSync(DIST_DIR)) return 0;
  let n = 0;
  for (const rel of rels) {
    const src = p(rel);
    if (!existsSync(src)) continue;
    copyFileSync(src, join(DIST_DIR, rel));
    n++;
  }
  if (n) console.log(`已同步 ${n} 个文件到 deploy-dist`);
  return n;
}

// 收集 4 个 HTML 中所有带 ?v= 的本地引用
function collectRefs() {
  const refs = [];
  for (const html of HTML_FILES) {
    const file = p(html);
    if (!existsSync(file)) continue;
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(REF_RE)) {
      refs.push({ html, attr: m[1], path: m[2], version: Number(m[0].match(/\?v=(\d+)/)[1]) });
    }
  }
  return refs;
}

function check(map) {
  const problems = [];
  const seen = new Set();
  for (const ref of collectRefs()) {
    seen.add(ref.path);
    const expected = map.assets[ref.path];
    if (expected === undefined) {
      problems.push(`UNKNOWN   ${ref.html}: ${ref.path}?v=${ref.version}（map 中无此资源）`);
    } else if (expected !== ref.version) {
      problems.push(`MISMATCH  ${ref.html}: ${ref.path}?v=${ref.version} → 应为 ?v=${expected}`);
    }
  }

  const sw = readFileSync(p('service-worker.js'), 'utf8');
  const cacheMatch = sw.match(/const CACHE_VERSION = '([^']+)'/);
  const expectedCache = `wdtv-sw-v${map.cacheVersion}`;
  if (!cacheMatch) problems.push('SW       找不到 CACHE_VERSION 常量');
  else if (cacheMatch[1] !== expectedCache) {
    problems.push(`SW       CACHE_VERSION='${cacheMatch[1]}' → 应为 '${expectedCache}'`);
  }

  // 运行时内部版本号（人工维护，仅核对提醒）
  const vc = readFileSync(p('js/video-cache.js'), 'utf8').match(/var VC_VERSION\s*=\s*(\d+)/);
  const rules = readFileSync(p('js/ad-filter.js'), 'utf8').match(/var RULES_VERSION\s*=\s*(\d+)/);
  const warnings = [];
  if (vc && Number(vc[1]) !== map.internalVersions['js/video-cache.js:VC_VERSION']) {
    warnings.push(`VC_VERSION=${vc[1]} 与 map 记录 ${map.internalVersions['js/video-cache.js:VC_VERSION']} 不一致（改过 video-cache.js 请核对）`);
  }
  if (rules && Number(rules[1]) !== map.internalVersions['js/ad-filter.js:RULES_VERSION']) {
    warnings.push(`RULES_VERSION=${rules[1]} 与 map 记录 ${map.internalVersions['js/ad-filter.js:RULES_VERSION']} 不一致（改过过滤规则请 +1）`);
  }

  const refs = collectRefs();
  console.log(`已扫描 ${HTML_FILES.length} 个 HTML，共 ${refs.length} 处带 ?v= 引用，map 登记 ${Object.keys(map.assets).length} 个资源。`);
  console.log(`无版本引用登记 ${map.unversioned.refs.length} 处（/libs/* 为 1 年 immutable，只能靠升 CACHE_VERSION 生效）。`);
  console.log('提示：改完 HTML ?v= / SW 后请跑 node scripts/selfcheck.mjs 校验 deploy-dist 镜像一致。');
  for (const w of warnings) console.log(`WARN     ${w}`);
  if (problems.length === 0) {
    console.log('OK       版本号与 CACHE_VERSION 全部一致。');
    return 0;
  }
  for (const line of problems) console.log(line);
  console.log(`\n发现 ${problems.length} 处不一致，可执行：node scripts/bump-version.mjs sync`);
  return 1;
}

function sync(map) {
  let changed = 0;
  const touched = []; // 本次实际改写的根文件（相对路径），用于镜像到 deploy-dist
  for (const html of HTML_FILES) {
    const file = p(html);
    if (!existsSync(file)) continue;
    const before = readFileSync(file, 'utf8');
    const after = before.replace(REF_RE, (full, attr, path) => {
      const v = map.assets[path];
      if (v === undefined) return full; // 未登记资源保持原样
      const next = `${attr}="${path}?v=${v}"`;
      if (next !== full) changed++;
      return next;
    });
    if (after !== before) {
      writeFileSync(file, after, 'utf8');
      touched.push(html);
      console.log(`同步 ${html}`);
    }
  }

  const swFile = p('service-worker.js');
  const before = readFileSync(swFile, 'utf8');
  const expectedCache = `wdtv-sw-v${map.cacheVersion}`;
  const after = before.replace(/const CACHE_VERSION = '[^']+'/, `const CACHE_VERSION = '${expectedCache}'`);
  if (after !== before) {
    writeFileSync(swFile, after, 'utf8');
    touched.push('service-worker.js');
    console.log(`同步 service-worker.js CACHE_VERSION → ${expectedCache}`);
  }
  console.log(`完成，共改写 ${changed} 处引用。`);
  mirrorToDist(touched);
  return 0;
}

function bump(map, targets) {
  if (!targets.length) {
    console.error('用法：node scripts/bump-version.mjs bump <资源路径...>  例如 js/app.js css/index.css');
    return 1;
  }
  for (const t of targets) {
    if (map.assets[t] === undefined) {
      console.error(`跳过：map 中未登记 ${t}（请先加进 scripts/version-map.json）`);
      continue;
    }
    map.assets[t] += 1;
    console.log(`${t} → ?v=${map.assets[t]}`);
  }
  writeMap(map);
  return sync(map);
}

function changelog(map, message) {
  if (!message) {
    console.error('用法：node scripts/bump-version.mjs changelog "改动说明"');
    return 1;
  }
  const n = map.changelogNext;
  const line = `// v${n}（${today()}）：${message}；升级缓存版本确保新资源即时到达\n`;
  const swFile = p('service-worker.js');
  let sw = readFileSync(swFile, 'utf8');
  const marker = "const CACHE_VERSION = ";
  const idx = sw.indexOf(marker);
  if (idx < 0) {
    console.error('找不到 CACHE_VERSION，未做任何修改');
    return 1;
  }
  // 避免重复追加同一条
  if (sw.includes(`// v${n}（`)) {
    console.error(`changelog 已存在 v${n}，未重复追加`);
    return 1;
  }
  sw = sw.slice(0, idx) + line + sw.slice(idx);
  const expectedCache = `wdtv-sw-v${n}`;
  sw = sw.replace(/const CACHE_VERSION = '[^']+'/, `const CACHE_VERSION = '${expectedCache}'`);
  writeFileSync(swFile, sw, 'utf8');

  map.cacheVersion = n;
  map.changelogNext = n + 1;
  writeMap(map);
  console.log(`已追加 changelog v${n}，CACHE_VERSION → ${expectedCache}，下一条 changelog 序号 v${n + 1}`);
  console.log('提示：升 CACHE_VERSION 会触发 SW activate 清空全部旧缓存，属预期行为。');
  mirrorToDist(['service-worker.js']);
  return 0;
}

const [cmd, ...args] = process.argv.slice(2);
const map = readMap();
let code = 0;
switch (cmd) {
  case 'sync': code = sync(map); break;
  case 'bump': code = bump(map, args); break;
  case 'changelog': code = changelog(map, args.join(' ')); break;
  case 'check':
  default:
    if (cmd && cmd !== 'check') console.log(`未知子命令 ${cmd}，默认执行 check\n`);
    code = check(map);
}
process.exit(code);
