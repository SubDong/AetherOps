#!/usr/bin/env node
/**
 * 钉版校验：声明必须是精确版本，且与实际安装的版本一致。
 *
 * 为什么要拦这一道：@cicctencent/agent-core 是黑盒引擎，ReAct 循环、内置工具、
 * 危险命令黑名单都住在里面。它出 1.0.83 而我们的代码是按 1.0.80 的行为写的，
 * 干净安装就会静默换一个内核 —— 出问题时光看日志根本看不出来是谁变了。
 * vite 同理：构建器版本直接决定前端产物内容。
 *
 * 挂在 build-only 最前面，于是 npm run build / electron-build.js / CI / Docker
 * 全都会先过这里；不通过就 exit 1，构建当场停，而不是产出一个"不知道跑的哪版引擎"的包。
 * 除了版本一致，它还看锁文件的形状（见 checkLockShape）。
 *
 * 升级请走 pnpm run upgrade-pin -- <pkg>@<ver>，它会改声明、刷锁、再回到这里复验。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 构建链统一的 pnpm 大版本（Dockerfile / .cnb.yml / .github/workflows 都装这个） */
const CI_PNPM_MAJOR = '10';

/** 需要钉死的包：行为不可预测、且我们没有能力灰度的那几个 */
const PINNED = [
  { name: '@cicctencent/agent-core', why: 'Agent 引擎（黑盒）' },
  { name: 'vite', why: '前端构建器（决定产物内容）' },
];

/** 精确版本：允许预发布后缀，拒绝 ^ ~ * x latest 与 || 组合 */
const EXACT_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function fail(line) {
  console.error(`[pin] ✗ ${line}`);
  return false;
}

/**
 * 读文本并剥掉 BOM。
 * Windows 下的编辑器 / PowerShell 的 Set-Content -Encoding utf8 习惯加 BOM，
 * 带着它 JSON.parse 会直接抛异常，整个校验变成一堆看不出所以然的堆栈。
 */
function readText(file) {
  return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
}

/**
 * 读实际安装的版本。
 * 直接拼 node_modules 路径而不是 createRequire.resolve：pnpm 下那是软链，
 * resolve 会跟着指到 .pnpm 里的真实目录，报错信息里出现的版本反而更难懂；
 * fs 读软链目标拿到的就是安装器认下的那一份。
 */
function installedVersion(name) {
  const manifest = path.join(ROOT, 'node_modules', name, 'package.json');
  if (!fs.existsSync(manifest)) return undefined;
  try {
    return JSON.parse(readText(manifest)).version;
  } catch {
    return undefined;
  }
}

const pkg = JSON.parse(readText(path.join(ROOT, 'package.json')));
const declaredAll = { ...pkg.dependencies, ...pkg.devDependencies };

/**
 * 锁文件必须是由 CI 那个 pnpm 大版本写的。
 *
 * 实测：pnpm 10 写出的 patchedDependencies 是结构体（hash + path），
 * pnpm 12 只要更新一次锁（加个依赖就会）就把它压回 `name: <hash>` 单行。
 * 本地 pnpm 12 读两种形式都不报错，而 CI 的 pnpm 10 在 --frozen-lockfile 下会直接
 * ERR_PNPM_LOCKFILE_CONFIG_MISMATCH —— 这个坑只在线上炸，而且报错完全看不出来跟 pnpm 版本有关，
 * 所以在这里提前拦。
 *
 * 不打算用 packageManager 字段把大家强制到 pnpm 10：pnpm 12 一旦看到这个字段会自动换版本，
 * 接着发现 node_modules 是另一个版本建的，就提“整个目录删除重装”—— 实测卡在那里等确认，
 * 而且会重编 node-pty / ssh2。开发机继续用 pnpm 12，仅靠下面这个形状检查拦住就行。
 */
function checkLockShape() {
  const lockFile = path.join(ROOT, 'pnpm-lock.yaml');
  if (!fs.existsSync(lockFile)) return fail('pnpm-lock.yaml 不在仓库里，CI 的 --frozen-lockfile 必红');

  const declaredPatch = pkg.pnpm?.patchedDependencies;
  const lock = readText(lockFile);
  // \r? 是必要的：有人把锁签出成 CRLF 时，只认 \n 就整段匹配不到，检查会默默放空
  const block = lock.match(/^patchedDependencies:\r?\n((?:[ \t]+.*(?:\r?\n|$))*)/m);

  // 声明里有补丁但锁里没 patches 段：补丁未生效，rz/sz 会默默回到不可靠状态
  if (declaredPatch && !block) {
    return fail('package.json / pnpm-workspace.yaml 声明了 patchedDependencies，但锁里没有对应段落——补丁没进锁');
  }
  if (!block) return true;

  // 单行形式 = 锁是 pnpm 11/12 写的。
  // 判据要排除 hash 这个键名：结构化形式长这样，它的那行 `hash: <64位>` 与单行形式形状完全一样，
  // 不排掉就会把好锁误判成坏锁（踩过）：
  //   zmodem.js:
  //     hash: dba85ba...
  //     path: patches/zmodem.js.patch
  // 所以只认「非 hash 的键名与 64 位哈希同一行」。
  const shorthand = block[1]
    .split(/\r?\n/)
    .map((line) => line.match(/^[ \t]+([^:\s]+):[ \t]*([0-9a-f]{64})[ \t]*$/))
    .filter(Boolean)
    .some((match) => match[1] !== 'hash');
  if (shorthand) {
    return fail(
      'pnpm-lock.yaml 是 pnpm 11/12 写的（patchedDependencies 是单行 hash），CI 的 pnpm 10 会在 --frozen-lockfile 下拒绝。\n'
      + `      修法：用与 CI 同大版本的 pnpm 重生成锁后再提交 —— npx pnpm@${CI_PNPM_MAJOR} install --lockfile-only`,
    );
  }
  return true;
}

let ok = checkLockShape();
const rows = [];

for (const { name, why } of PINNED) {
  const spec = declaredAll[name];
  if (spec === undefined) {
    ok = fail(`${name}（${why}）在 package.json 里没有声明`) && ok;
    continue;
  }
  if (!EXACT_RE.test(spec)) {
    ok = fail(
      `${name}（${why}）声明成了范围「${spec}」。范围意味着每次干净安装都可能解析到不同版本，`
      + `请在 package.json 写死具体版本（或用 pnpm run upgrade-pin -- ${name}@<版本>）`,
    ) && ok;
    continue;
  }
  const installed = installedVersion(name);
  if (installed === undefined) {
    ok = fail(`${name} 声明 ${spec}，但 node_modules 里没装 —— 先跑 pnpm install`) && ok;
    continue;
  }
  if (installed !== spec) {
    ok = fail(`${name} 声明 ${spec}，实际装的是 ${installed}。锁文件或 node_modules 与声明不一致`) && ok;
    continue;
  }
  rows.push(`${name}=${spec}`);
}

if (!ok) {
  console.error('[pin] 依赖钉版校验未通过，构建终止。');
  process.exit(1);
}

// 通过时只留一行：构建日志不该被校验脚本刷屏，但线上排查时要能确认跑的是哪版
console.log(`[pin] 依赖钉版校验通过：${rows.join(' ')}`);
