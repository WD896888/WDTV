// 生成 css/slideqiuhong.css：账号名称中文字体「演示秋鸿楷」
// 来源：cn-fontsource-slideqiuhong-regular@1.0.6（开源免费商用）
// 做法：取原包 font.css，把分片相对 URL 改成 CDN 绝对地址（字体文件不随项目分发），
//       并补上 font-display:swap（原表缺失，默认 auto 会在字体加载期间把昵称整段藏起来）。
// 用法：node scripts/build-slideqiuhong-font.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = 'cn-fontsource-slideqiuhong-regular';
const VER = '1.0.6';
const CDN = `https://cdn.jsdelivr.net/npm/${PKG}@${VER}/`;

const res = await fetch(`${CDN}font.css`);
if (!res.ok) {
    console.error('下载 font.css 失败：', res.status);
    process.exit(1);
}
let css = await res.text();

css = css.replace(/url\('(L1_[^']+\.woff2)'\)/g, (m, f) => `url('${CDN}${f}')`);
css = css.replace(
    /@font-face \{font-family: 'Slideqiuhong';/g,
    "@font-face {font-family: 'Slideqiuhong';font-style: normal;font-weight: 400;font-display: swap;"
);

const header = `/* 演示秋鸿楷（Slideqiuhong）—— 账号名称中文字体
   来源：cn-fontsource-slideqiuhong-regular@${VER}（开源免费商用）
   ${CDN}
   · 由原包 font.css 改造：分片 URL 改为 CDN 绝对地址（字体文件不随项目分发），
     并补上 font-display:swap（原表缺失，用默认 auto 会在字体加载期间把昵称整段藏起来）。
   · 字符集只含汉字（U+4E00 起），不含拉丁字母与数字 —— 英文/数字仍由 Sriracha 渲染，
     因此字体栈写作 'Slideqiuhong','Sriracha',… 。
   · 分片按 unicode-range 切分，浏览器只下载页面实际用到的那几片。
   · 升级字体版本时重新运行本脚本生成。 */
`;

const out = path.join(root, 'css', 'slideqiuhong.css');
fs.writeFileSync(out, header + css);
const kb = (fs.statSync(out).size / 1024).toFixed(1);
console.log(`已生成 css/slideqiuhong.css：${kb}KB，${(css.match(/@font-face/g) || []).length} 个分片`);
