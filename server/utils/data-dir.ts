import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

/** 上游 AICmd 时期使用的数据目录名，本仓库重命名为 AetherOps 后需要把老数据搬过来 */
const LEGACY_DATA_DIRNAME = '.aicmd';
const NEW_DATA_DIRNAME = '.aetherops';

let legacyMigrationDone = false;

/**
 * 把旧版（~/.aicmd）的数据迁移到新目录（~/.aetherops）。
 *
 * 只迁一次，且严格遵守：
 * - 用户显式指定了 AETHEROPS_DATA_DIR 时不动任何东西（那是用户自己的选址意图）
 * - 新目录已有内容时不覆盖，只提示，避免把两边数据混坏
 * - 跨设备 rename 失败时退回复制，且原目录改名为 .aicmd.migrated.bak 而不是删除
 * - 迁移失败绝不阻塞启动
 *
 * 注意：加密密钥文件 .key 与 connections.json 一起搬迁，
 * 因此迁过来的密文仍可正常解密，不会出现"升级后密码全废"。
 */
function migrateLegacyDataDir(dir: string): void {
  if (legacyMigrationDone) return;
  legacyMigrationDone = true;
  // 显式指定过数据目录 -> 尊重用户选址，不做任何搬迁
  if (process.env.AETHEROPS_DATA_DIR) return;

  const legacyDir = path.join(os.homedir(), LEGACY_DATA_DIRNAME);
  if (path.resolve(legacyDir) === path.resolve(dir)) return;

  try {
    if (!fs.existsSync(legacyDir)) return;

    const newEntries = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    if (newEntries.length > 0) {
      console.warn(`[data-dir] 检测到旧数据目录 ${legacyDir}，但新目录 ${dir} 已有内容；为避免覆盖不做自动迁移。`);
      console.warn(`[data-dir] 如需合并，请手动把 ${legacyDir} 下的内容复制到 ${dir}（connections.json 需自行合并）。`);
      return;
    }

    // 新目录不存在或为空 -> 直接整体搬迁
    try {
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      fs.renameSync(legacyDir, dir);
      console.log(`[data-dir] Migrated legacy data directory: ${legacyDir} -> ${dir}`);
      return;
    } catch (e: any) {
      // 跨盘符 / 跨挂载点（Windows 不同分区、Linux 不同 mount）rename 会 EXDEV，退回复制
      console.warn(`[data-dir] rename 迁移失败（${e.message}），改用复制方式`);
      fs.cpSync(legacyDir, dir, { recursive: true });
      const backupDir = `${legacyDir}.migrated.bak`;
      try {
        fs.renameSync(legacyDir, backupDir);
      } catch { /* 备份目录已存在等情况：保留原目录，不清理 */ }
      console.log(`[data-dir] Copied legacy data to ${dir}`);
      console.warn(`[data-dir] 旧目录保留为 ${backupDir}，确认无误后可自行删除。`);
    }
  } catch (e: any) {
    console.error(`[data-dir] 旧数据目录迁移跳过: ${e.message}`);
  }
}

/**
 * 获取数据目录路径（统一入口）
 * 所有需要写入的文件（PID、日志、配置、会话等）都必须通过此函数获取目录
 *
 * 优先级：环境变量 AETHEROPS_DATA_DIR > ~/.aetherops
 * 副作用：首次调用时会把旧版的 ~/.aicmd 搬迁过来（见 migrateLegacyDataDir）
 */
export function getDataDir(): string {
  const dir = process.env.AETHEROPS_DATA_DIR || path.join(os.homedir(), NEW_DATA_DIRNAME);
  migrateLegacyDataDir(dir);
  console.log(`[data-dir] getDataDir: ${dir}, home: ${os.homedir()}`);
  return dir;
}

/**
 * 确保数据目录存在，不存在则创建
 */
export function ensureDataDir(): string {
  const dir = getDataDir();
  try {
    console.log(`[data-dir] ensureDataDir: ${dir}`);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      console.log(`[data-dir] Created directory: ${dir}`);
    }
    fs.accessSync(dir, fs.constants.W_OK);
    console.log(`[data-dir] Directory is writable: ${dir}`);
  } catch (e: any) {
    console.error(`[data-dir] Cannot create/access data directory ${dir}: ${e.message}`);
    console.error(`[data-dir] dir exists: ${fs.existsSync(dir)}`);
    throw e;
  }
  return dir;
}

/**
 * 获取数据目录下的文件绝对路径
 * @param filename 文件名或相对路径（如 'server.log', 'ai-history/xxx.json'）
 */
export function getDataPath(...segments: string[]): string {
  return path.join(getDataDir(), ...segments);
}

/**
 * 确保指定目录存在且可写
 * - 目录不存在时递归创建
 * - 权限不足时尝试修复为 0o755
 * - 全部失败返回 false，不抛异常
 */
export function ensureDir(dir: string): boolean {
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    // 检查是否可写
    try {
      fs.accessSync(dir, fs.constants.W_OK);
    } catch {
      try { fs.chmodSync(dir, 0o755); } catch (_) { /* 无权限修复则忽略 */ }
    }
    return true;
  } catch (e: any) {
    console.warn(`[data-dir] Cannot create/fix directory (${dir}): ${e.message}`);
    return false;
  }
}

/**
 * 递归修复目录及文件权限：目录 755，文件 644
 */
export function fixPermissions(dir?: string): void {
  const targetDir = dir || getDataDir();
  try {
    fs.chmodSync(targetDir, 0o755);
    const entries = fs.readdirSync(targetDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(targetDir, entry.name);
      try {
        if (entry.isDirectory()) {
          fixPermissions(fullPath);
        } else {
          fs.chmodSync(fullPath, 0o644);
        }
      } catch { /* 单个文件失败不影响其他 */ }
    }
  } catch { /* ignore */ }
}
