#!/usr/bin/env node
/**
 * 钉版依赖的唯一升级入口。
 *
 * 用法：
 *   pnpm run upgrade-pin -- @cicctencent/agent-core@1.0.83
 *   pnpm run upgrade-pin -- vite@8.4.0
 *   node scripts/upgrade-pin.mjs @cicctencent/agent-core@1.0.83 --dry-run
 *
 * 为什么要有这个脚本，而不是直接 pnpm add：升级一个黑盒引擎真正的成本不在装包，
 * 在于确认行为没变。所以这里把顺序固定下来 —— 先看现状、只改声明的那一行、
 * 刷锁、再回到 check-engine-pin 复验，最后把 diff 摊到你面前由你决定提不提交。
 * 脚本全程不做 git 操作，也不碰 node_modules 以外的东西。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG_PATH = path.join(ROOT, 'package.json');
const EXACT_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
/** 构建链统一的 pnpm 大版本（与 check-engine-pin.mjs 里那个保持一致） */
const CI_PNPM_MAJOR = '10';

function die(line) {
  console.error(`[upgrade-pin] ✗ ${line}`);
  process.exit(1);
}

/**
 * 剥 BOM 再读：Windows 编辑器 / PowerShell Set-Content 习惯把 package.json 写成带 BOM 的 UTF-8，
 * 不剥就是 JSON.parse 直接报错。写回时仍用原始文本，不动那个 BOM。
 */
function readText(file) {
  return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
}

const argv = process.argv.slice(2).filter((a) => a !== '--');
const dryRun = argv.includes('--dry-run');
const target = argv.find((a) => !a.startsWith('--'));

if (!target) {
  die('缺少参数。用法：pnpm run upgrade-pin -- <包名>@<精确版本>，例如 -- @cicctencent/agent-core@1.0.83');
}

// 包名里可以带一次 @（scoped 包的前导 @），所以从最后一个 @ 切
const at = target.lastIndexOf('@');
if (at <= 0) die(`「${target}」看不出版本。要写全：<包名>@<版本>`);
const name = target.slice(0, at);
const version = target.slice(at + 1);

if (!EXACT_RE.test(version)) {
  die(`钉版升级只接受精确版本，收到「${version}」。范围（^ ~ latest）等于把版本交给安装器决定`);
}

const pkg = JSON.parse(readText(PKG_PATH));
const bucket = pkg.dependencies?.[name] !== undefined
  ? 'dependencies'
  : pkg.devDependencies?.[name] !== undefined ? 'devDependencies' : undefined;
if (!bucket) die(`${name} 不在 package.json 的 dependencies / devDependencies 里，不该由本脚本改`);

const current = pkg[bucket][name];
console.log(`[upgrade-pin] ${name}`);
console.log(`  当前声明：${current}`);
console.log(`  目标版本：${version}`);
console.log(`  所在字段：${bucket}`);

// 工作区脏不脏要说出来：升级后一旦要回滚，靠的就是 git checkout 这两个文件，
// 如果里面混着别的改动，回滚会把不相干的工作一起抹掉
try {
  const dirty = execFileSync('git', ['status', '--porcelain', '--', 'package.json', 'pnpm-lock.yaml'], {
    cwd: ROOT, encoding: 'utf8',
  }).trim();
  if (dirty) console.warn(`[upgrade-pin] ⚠ package.json / pnpm-lock.yaml 已有未提交改动：\n${dirty}`);
} catch { /* 不在 git 环境里不拦，升级本身照样可回滚 */ }

if (dryRun) {
  console.log('[upgrade-pin] --dry-run：未做任何修改');
  process.exit(0);
}

// 只替换那一行的版本号，不 JSON.stringify 整个对象：
// 否则字段顺序、缩进、行尾风格会被动过，diff 里看不出你到底升了哪个包
const original = fs.readFileSync(PKG_PATH, 'utf8');
const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// key 在 JSON 文本里是带引号的，匹配时要把这对引号一起写进去，否则一行都定位不到
const lineRe = new RegExp(`(^\\s*"${escaped}"\\s*:\\s*)"[^"]*(")`, 'm');
if (!lineRe.test(original)) die(`在 package.json 文本里没定位到 ${name} 这一行，请手动改`);
fs.writeFileSync(PKG_PATH, original.replace(lineRe, `$1"${version}"`), 'utf8');
console.log(`[upgrade-pin] 已写入 package.json：${name}@${version}`);

// pnpm install 会按新声明重解析这一个包并同步 pnpm-lock.yaml；
// 其余依赖保持锁定，不会顺带升级
console.log('[upgrade-pin] pnpm install（同步 node_modules 与 pnpm-lock.yaml）...');
const install = spawnSync('pnpm', ['install'], { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
if (install.status !== 0) {
  die(`pnpm install 失败（退出码 ${install.status}）。回滚：git checkout -- package.json pnpm-lock.yaml && pnpm install`);
}

// 复验前必须先把锁重写成 CI 那把 pnpm 的形状：
// 上面用的是开发机自己的 pnpm，它会把 patchedDependencies 写成单行 hash，
// 而 CI 的 pnpm 10 + --frozen-lockfile 不认那份形状（实测 ERR_PNPM_LOCKFILE_CONFIG_MISMATCH）。
// 这里用 --lockfile-only 只写锁、不碰 node_modules；直接拿 pnpm 10 装完整依赖会反过来
// 提“把 node_modules 删除重装”，把开发机的原生依赖折腾一遍。
console.log(`[upgrade-pin] 用 pnpm@${CI_PNPM_MAJOR} 重写锁（--lockfile-only，不动 node_modules）...`);
const reshape = spawnSync('npx', ['--yes', `pnpm@${CI_PNPM_MAJOR}`, 'install', '--lockfile-only'], {
  cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32',
});
if (reshape.status !== 0) {
  die(`重写锁失败（退出码 ${reshape.status}）。手动跑：npx pnpm@${CI_PNPM_MAJOR} install --lockfile-only`);
}

// 复验走同一个脚本：构建时跑的就是它，现在过了构建才会过
console.log('[upgrade-pin] 复验钉版一致性...');
const check = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'check-engine-pin.mjs')], {
  cwd: ROOT, stdio: 'inherit',
});
if (check.status !== 0) die('复验未通过，别急着提交，先看上面的报错');

console.log('\n[upgrade-pin] 升级完成。后续动作由你确认：');
console.log('  1. 看改动      git diff -- package.json pnpm-lock.yaml');
console.log('  2. 本地验证    pnpm run build-only && pnpm run verify-auth');
console.log('     （引擎换了行为可能变：工具调用格式、危险命令拦截、事件流字段都要实际跑一轮 Agent）');
console.log('  3. 一起提交    package.json 与 pnpm-lock.yaml 必须同进一个 commit，否则 CI 的 --frozen-lockfile 会失败');
console.log('  回滚           git checkout -- package.json pnpm-lock.yaml && pnpm install');
