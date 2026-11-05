#!/usr/bin/env node
/**
 * 一键把当前仓库打成 Docker 镜像。
 *
 * 为什么要包一层而不是直接 `docker build -t aetherops .`：
 *  - 这个镜像的失败模式大多在构建跑到一半才炸，而原因在构建开始之前就能查出来
 *    （Dockerfile 要 COPY 的 package.json / pnpm-lock.yaml / pnpm-workspace.yaml /
 *    patches 少一个、daemon 没起、构建上下文把 node_modules 或上一轮的发版产物算进来）；
 *    脚本把这些做成开跑前的显式检查，报错是一句话而不是一屏栈。
 *  - 镜像必须能对得上号：仓库里没有 engines/packageManager 之外的版本锚点，出问题时要能
 *    从镜像反查是哪次提交、哪个版本构建的，所以固定打 OCI label。
 *  - tag 从 package.json 的 version 来，避免手工写版本号写错（发版流程本来就按版本对齐）。
 *
 * 用法：
 *   pnpm docker:build                                  # aetherops:<version> + aetherops:latest
 *   pnpm docker:build -- --tag registry.example.com/aetherops --push
 *   pnpm docker:build -- --platform linux/amd64        # 交叉构建，走 buildx + --load
 *   pnpm docker:build -- --no-cache --pull --dry-run   # 只看要执行什么
 *
 * 未识别的选项原样透传给 docker build，不需要在这里为每个 flag 开口子。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const pkg = readJson(path.join(ROOT, 'package.json'));

/** 剥掉行尾注释与空行，只留 .dockerignore 里真正生效的模式行 */
function parseIgnore(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'));
}

/**
 * 模式匹配只做到「目录名 + 通配后缀」这一层够用：
 * .dockerignore 的语义比这复杂（** 、! 取反、多层路径），但这里只回答一个问题 ——
 * 「某个已知很重的顶层目录有没有被排除」，判不出来的情况一律当作已排除，避免误报。
 */
function isIgnored(patterns, rel) {
  const top = rel.split('/')[0];
  return patterns.some(p => {
    const clean = p.replace(/\/+$/, '');
    if (clean.startsWith('!')) return false;
    if (clean === rel || clean === top) return true;
    if (clean.startsWith('*') && rel.endsWith(clean.slice(1))) return true;
    return false;
  });
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', ...opts });
}

/** 取一条命令的 stdout；失败就返回 undefined，让调用方决定怎么说 */
function capture(args) {
  const r = run('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error || r.status !== 0) return undefined;
  return (r.stdout || '').trim();
}

// ---------- 参数 ----------

const argv = process.argv.slice(2);
const flags = { name: 'aetherops', version: pkg.version, latest: true, file: 'Dockerfile', context: '.' };
const passthrough = [];

for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  const next = () => argv[++i];
  switch (arg) {
    case '--tag': case '-t': flags.name = next(); break;
    case '--version': flags.version = next(); break;
    case '--no-latest': flags.latest = false; break;
    case '--file': case '-f': flags.file = next(); break;
    case '--context': flags.context = next(); break;
    case '--platform': flags.platform = next(); break;
    case '--push': flags.push = true; break;
    case '--dry-run': flags.dryRun = true; break;
    default: passthrough.push(arg);
  }
}

const refs = [`${flags.name}:${flags.version}`];
if (flags.latest) refs.push(`${flags.name}:latest`);

// ---------- 开跑前的检查 ----------

const problems = [];
const notes = [];

/** Dockerfile 会 COPY 这几个文件，缺一个就是「构建到第 5 步才说找不到文件」那种难看失败 */
for (const needed of ['Dockerfile', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'patches']) {
  if (!fs.existsSync(path.join(ROOT, needed))) {
    problems.push(`${needed} 不存在，而 Dockerfile 要 COPY 它 —— 构建会在依赖安装阶段才失败`);
  }
}
if (!fs.existsSync(path.join(ROOT, flags.file))) problems.push(`构建文件 ${flags.file} 不存在`);

const dockerVersion = capture(['version', '--format', '{{.Server.Version}}']);
if (!dockerVersion) {
  const probe = run('docker', ['version', '--format', '{{.Server.Version}}'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const reason = probe.error?.code === 'ENOENT'
    ? 'PATH 里找不到 docker，需要先装 Docker Desktop / docker engine'
    : (probe.stderr || probe.stdout || '').trim().split('\n')[0] || '未知原因';
  // --dry-run 的用途是「先看要跑什么」，不该强迫你把 Docker Desktop 开起来；
  // 真构建时才把同一个问题当阻断
  if (flags.dryRun) notes.push(`docker daemon 现在不可用（${reason}）—— dry-run 不拦，真正构建前需要先解决`);
  else problems.push(`docker daemon 不可用：${reason}`);
}

if (dockerVersion && passthrough.includes('--load') && flags.platform) {
  notes.push('--platform 已经会让脚本自己走 buildx --load，不必再传 --load');
}

/**
 * 上下文体检。
 * Dockerfile 是 `COPY . .`，被 .dockerignore 漏掉的目录会真的进上下文：
 * 第一次是慢（几百 MB 白传），第二次是错（把上一轮本地构建产物 / 别的平台的 node_modules
 * 混进镜像，而构建阶段装的依赖是 frozen-lockfile 的，两掺之后没人说得清跑的是哪份）。
 */
const ignoreFile = path.join(ROOT, '.dockerignore');
const patterns = parseIgnore(ignoreFile);
if (!fs.existsSync(ignoreFile)) {
  problems.push('没有 .dockerignore：`COPY . .` 会把 node_modules 和所有本地构建产物塞进上下文');
} else {
  const heavy = [];
  for (const dir of fs.readdirSync(ROOT)) {
    if (dir === 'node_modules') heavy.push(dir);
    else if (/^(dist|dist\.\w+|release|nw-cache|\.next)$/.test(dir)) heavy.push(dir);
  }
  const vscodeDir = path.join(ROOT, 'packages', 'vscode');
  if (fs.existsSync(path.join(vscodeDir, 'runtime'))) heavy.push('packages/vscode/runtime');
  if (fs.existsSync(vscodeDir) && fs.readdirSync(vscodeDir).some(f => f.endsWith('.vsix'))) {
    heavy.push('packages/vscode/*.vsix');
  }
  for (const f of fs.readdirSync(ROOT)) {
    if (f.endsWith('.vsix')) heavy.push(f);
  }
  const leaked = [...new Set(heavy)].filter(h => !isIgnored(patterns, h));
  if (leaked.length) {
    problems.push(`这些目录/文件会被打进构建上下文，但 .dockerignore 没有排除：${leaked.join(', ')}\n`
      + '      修法：把它们加进 .dockerignore（镜像里用不到 —— 生产阶段只 COPY dist/node_modules/'
      + 'server.js/bin/public/data/skills）');
  }
}

// 工作树是否干净：镜像出问题时第一个问题就是「到底构建的哪份代码」
const gitStatus = run('git', ['status', '--porcelain'], { stdio: ['ignore', 'pipe', 'pipe'] });
if (gitStatus.error) {
  notes.push('git 不可用，label 里的 revision 会记成 unknown');
} else if (gitStatus.status === 0 && (gitStatus.stdout || '').trim()) {
  notes.push(`工作树有 ${gitStatus.stdout.trim().split(/\r?\n/).length} 项未提交改动：镜像内容对不上任何一次提交，label 里的 commit 只是「构建时的 HEAD」`);
}

const sha = run('git', ['rev-parse', '--short', 'HEAD'], { stdio: ['ignore', 'pipe', 'pipe'] });
const revision = sha.status === 0 ? (sha.stdout || '').trim() : 'unknown';

if (problems.length) {
  console.error('[docker] 构建前置检查未通过：');
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}

// ---------- 组装命令 ----------

const buildArgs = [];
// 交叉构建只有 buildx 能表达；本机架构构建继续用 docker build，行为与文档里的手改命令一致
if (flags.platform) buildArgs.push('buildx', 'build', '--platform', flags.platform);
else buildArgs.push('build');
buildArgs.push('-f', flags.file);
for (const ref of refs) buildArgs.push('-t', ref);
buildArgs.push(
  '--label', `org.opencontainers.image.title=${pkg.name}`,
  '--label', `org.opencontainers.image.version=${flags.version}`,
  '--label', `org.opencontainers.image.revision=${revision}`,
  '--label', `org.opencontainers.image.created=${new Date().toISOString()}`,
);
// buildx 默认只出镜像清单，不加 --load 就进不了本地镜像列表，"构建成功但 docker images 查不到"
if (flags.platform && !flags.push) buildArgs.push('--load');
buildArgs.push(...passthrough, flags.context);

console.log(`[docker] 上下文 ${ROOT}`);
console.log(`[docker] 产出 tag：${refs.join('  ')}   (commit ${revision})`);
for (const n of notes) console.log(`[docker] ! ${n}`);
console.log(`[docker] $ docker ${buildArgs.join(' ')}`);

if (flags.dryRun) {
  console.log('[docker] --dry-run：到此为止，没有执行构建');
  process.exit(0);
}

const built = run('docker', buildArgs, { stdio: 'inherit' });
if (built.status !== 0) {
  console.error(`[docker] 构建失败（退出码 ${built.status ?? 'signal'}）。`);
  console.error('  这一步最常见的两类原因：');
  console.error('  1) 依赖装不上 —— Dockerfile 用 pnpm@10 + --frozen-lockfile，锁形状不对会报');
  console.error('     ERR_PNPM_LOCKFILE_CONFIG_MISMATCH，本地先用 pnpm run check-pin 复现（见 docs/deployment.md）');
  console.error('  2) 基础镜像或阿里云/npmmirror 源不可达 —— 换 Dockerfile 里的镜像端点，或 --pull 后重试');
  process.exit(built.status ?? 1);
}

if (flags.push) {
  for (const ref of refs) {
    console.log(`[docker] $ docker push ${ref}`);
    const pushed = run('docker', ['push', ref], { stdio: 'inherit' });
    if (pushed.status !== 0) {
      console.error(`[docker] push ${ref} 失败：先 docker login，并确认 tag 里有你有权写的命名空间`);
      process.exit(pushed.status ?? 1);
    }
  }
}

const size = capture(['images', '--format', '{{.Size}}', refs[0]]);
console.log(`[docker] ✓ 镜像就绪：${refs.join('  ')}${size ? `  (${size})` : ''}`);
console.log('[docker] 下一步（MySQL 与 Redis 是硬依赖，镜像里不含，连不上服务直接退出）：');
console.log('  docker run -d -p 127.0.0.1:9802:9802 \\');
console.log(`    -e AETHEROPS_DB_HOST=... -e AETHEROPS_DB_USER=... -e AETHEROPS_DB_PASSWORD=... \\`);
console.log('    -e AETHEROPS_REDIS_HOST=... -v aetherops-data:/root/.aetherops ' + refs[0]);
console.log('[docker] 完整 compose（含 MySQL/Redis 健康检查）见 docs/deployment.md 的 Docker 一节；');
console.log('         中文版 docs/deployment.zh.md');
