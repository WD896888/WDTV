// WDTV 零依赖测试入口
//
// 项目 test/*.test.mjs 用的是自定义断言 + process.exit(1) 风格（见 ad-filter.test.mjs），
// 不是 node:test。直接 `node --test test/` 在 Windows 下会把目录当模块加载（MODULE_NOT_FOUND），
// 所以这里逐个文件用子进程执行并汇总退出码，跨平台稳定。
//
// 用法：node scripts/run-tests.mjs   （npm test 已指向本脚本）

import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const root = join(scriptsDir, '..');
const testDir = join(root, 'test');

const files = readdirSync(testDir)
  .filter((f) => f.endsWith('.test.mjs'))
  .sort();

if (files.length === 0) {
  console.error('test/ 下没有找到 *.test.mjs');
  process.exit(1);
}

let failed = 0;
for (const f of files) {
  console.log(`\n===== ${f} =====`);
  const r = spawnSync(process.execPath, [join(testDir, f)], { stdio: 'inherit' });
  if (r.status !== 0) {
    failed++;
    console.error(`FAIL  ${f}（退出码 ${r.status ?? '未知'}${r.error ? '，' + r.error.message : ''}）`);
  }
}

console.log(`\n========================================`);
console.log(`测试文件 ${files.length} 个，通过 ${files.length - failed} 个，失败 ${failed} 个`);
process.exit(failed ? 1 : 0);
