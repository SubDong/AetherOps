/**
 * 双语文档一致性检查（CI 门禁，不需要数据库）。
 *
 * CONTRIBUTING 要求 docs/ 下每个 `foo.md` 与 `foo.zh.md` 成对修改，README 的两张表都要列出。
 * 这里把「成对」这件事变成可执行的断言，而不是评审时靠人眼：
 * 1. 成对：docs 下不允许孤儿文件（只有 .md 或只有 .zh.md）；
 * 2. 语言切换行：英文版第 3 行必须指向中文版，反之亦然 —— 这是两篇互为同源的最直接标记；
 * 3. 标题结构：h1..h4 的层级序列逐条相同（同一节在两边都存在，顺序一致），标题文字不比对；
 * 4. README 覆盖：每个文档都出现在 README.md 和 README.zh.md 的文档表里，且指向自己语言的那份；
 * 5. Known limitations / 已知边界 两个小节的条目数一致（改了英文忘了中文时最先露馅的地方）；
 * 6. 排版硬伤：代码围栏成对、行尾无空白、相对链接指向的文件真实存在。
 *
 * 行宽不检查：仓库里既有手写折行也有表格与长链接，历史文件大量超过 100 列，
 * 把它当门禁只会逼着人去改无关段落。
 *
 * 用法：node scripts/verify-docs.mjs（CI 里也在跑；不需要 dist 产物）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');
const exists = (rel) => fs.existsSync(path.join(root, rel));

const problems = [];
const fail = (rule, detail) => problems.push(`[${rule}] ${detail}`);
let passes = 0;
const pass = () => { passes += 1; };

// ---------- 1. 成对 ----------
const docFiles = fs.readdirSync(path.join(root, 'docs')).filter((f) => f.endsWith('.md'));
const enDocs = docFiles.filter((f) => !f.endsWith('.zh.md')).sort();
const zhDocs = docFiles.filter((f) => f.endsWith('.zh.md')).sort();
for (const f of enDocs) {
  if (!zhDocs.includes(f.replace(/\.md$/, '.zh.md'))) fail('成对', `docs/${f} 缺少中文版 ${f.replace(/\.md$/, '.zh.md')}`);
  else pass();
}
for (const f of zhDocs) {
  if (!enDocs.includes(f.replace(/\.zh\.md$/, '.md'))) fail('成对', `docs/${f} 缺少英文版 ${f.replace(/\.zh\.md$/, '.md')}`);
}

// ---------- 2. 语言切换行 ----------
const head = (rel, n = 4) => read(rel).split('\n').slice(0, n).filter((l) => l.trim() !== '');
for (const f of enDocs) {
  const twin = f.replace(/\.md$/, '.zh.md');
  if (!exists(`docs/${twin}`)) continue;
  const line = head(`docs/${f}`).find((l) => l.includes('**English**'));
  if (!line || !line.includes(`](./${twin})`)) {
    fail('切换行', `docs/${f} 第 3 行应形如 **English** · [简体中文](./${twin})，实际: ${line || '(缺失)'}`);
  } else pass();
  const zhLine = head(`docs/${twin}`).find((l) => l.includes('**简体中文**'));
  if (!zhLine || !zhLine.includes(`](./${f})`)) {
    fail('切换行', `docs/${twin} 第 3 行应形如 [English](./${f}) · **简体中文**，实际: ${zhLine || '(缺失)'}`);
  } else pass();
}

// ---------- 3. 标题结构 ----------
const headingLevels = (rel) =>
  read(rel)
    .split('\n')
    .filter((l) => /^#{1,4} /.test(l))
    .map((l) => (l.match(/^#+/) || [''])[0].length);
for (const f of enDocs) {
  const twin = f.replace(/\.md$/, '.zh.md');
  if (!exists(`docs/${twin}`)) continue;
  const a = headingLevels(`docs/${f}`);
  const b = headingLevels(`docs/${twin}`);
  // 不要求全文只有一个 h1：deployment.md 把 「# 5. Optional」这类步骤也写成一级标题
  if (a.join(',') !== b.join(',')) {
    fail('标题结构', `docs/${f} 与 ${twin} 层级不一致：en=[${a}] zh=[${b}]`);
  } else pass();
}

// ---------- 4. README 覆盖 ----------
for (const [readme, suffix] of [['README.md', ''], ['README.zh.md', '.zh']]) {
  const raw = read(readme);
  for (const f of enDocs) {
    const target = f.replace(/\.md$/, `${suffix}.md`);
    if (!exists(`docs/${target}`)) continue;
    if (!raw.includes(`./docs/${target}`)) fail('README 覆盖', `${readme} 的文档表未列出 docs/${target}`);
    else pass();
  }
}

// ---------- 5. Known limitations 条目数 ----------
function bullets(rel, headingRe) {
  const lines = read(rel).split('\n');
  const start = lines.findIndex((l) => headingRe.test(l));
  if (start < 0) return null;
  const out = [];
  for (let i = start + 1; i < lines.length && !/^## /.test(lines[i]); i += 1) {
    if (/^- /.test(lines[i])) out.push(lines[i].slice(2, 40));
  }
  return out;
}
const enLimits = bullets('README.md', /^## Known limitations\s*$/);
const zhLimits = bullets('README.zh.md', /^## 已知边界\s*$/);
if (!enLimits || !zhLimits) {
  fail('已知边界', 'README.md 的 `## Known limitations` 或 README.zh.md 的 `## 已知边界` 找不到');
} else if (enLimits.length !== zhLimits.length) {
  fail('已知边界', `条目数不一致：README.md ${enLimits.length} 条 / README.zh.md ${zhLimits.length} 条`);
} else pass();

// ---------- 6. 排版硬伤 ----------
const LINK = /\[[^\]]*\]\(([^)\s]+)\)/g;
const markdownFiles = [
  ...enDocs.map((f) => `docs/${f}`),
  ...zhDocs.map((f) => `docs/${f}`),
  'README.md',
  'README.zh.md',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
];
for (const rel of markdownFiles) {
  if (!exists(rel)) continue;
  const raw = read(rel);
  const lines = raw.split('\n');
  const fences = lines.filter((l) => /^\s*(```|~~~)/.test(l)).length;
  if (fences % 2 !== 0) fail('围栏', `${rel} 的代码围栏 ${fences} 个（必须成对）`);
  else pass();
  lines.forEach((l, i) => {
    if (/[ \t]+$/.test(l)) fail('行尾空白', `${rel}:${i + 1}`);
  });
  for (const m of raw.matchAll(LINK)) {
    const href = m[1];
    if (/^(https?:|mailto:|#)/.test(href)) continue;
    const target = href.split('#')[0];
    if (!target) continue;
    const resolved = target.startsWith('/') ? target.slice(1) : path.posix.join(path.posix.dirname(rel), target);
    if (!exists(resolved)) fail('链接', `${rel} 指向不存在的 ${target}`);
    else pass();
  }
}

// ---------- 输出 ----------
const uniq = [...new Set(problems)];
if (uniq.length === 0) {
  console.log(`docs: ${enDocs.length} 对双语文档，${passes} 项检查通过`);
  process.exit(0);
}
console.log(`docs: ${passes} 项通过，${uniq.length} 个问题`);
for (const p of uniq) console.log(`  ${p}`);
process.exit(1);
