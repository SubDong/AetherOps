import * as fs from 'fs';
import * as path from 'path';
import { getDataPath, getDataDir, ensureDataDir } from './data-dir';

/**
 * 统一配置入口。
 *
 * 背景：改造前本项目没有配置文件机制——package.json 里虽然装了 dotenv，
 * 但没有任何源文件 import 它，所有配置都是散落在各处的 process.env 直读。
 * 存储改用 MySQL 后必须有一份能承载账号密码的配置文件，于是有了这个模块。
 *
 * 配置文件定位（两个候选，不是叠加）：
 *   1. AETHEROPS_CONFIG 指向的文件（绝对路径，或相对当前工作目录）
 *   2. 默认：数据目录下的 config.json
 * 参数来源优先级：内置默认值 < 配置文件 < 环境变量。
 *
 * 为什么默认在数据目录而不是程序目录：VSCode 宿主的 server.js cwd 是
 * extensionPath/runtime（目录名带扩展版本号，每次升级就换一个）、
 * Electron 打包后程序目录在 Program Files/.app 不可写、
 * 放仓库根则有把密码文件误提交进 git 的风险。
 *
 * 关于数据目录：默认位置的 config.json 自身就放在数据目录里，所以「数据目录在哪」
 * 不能由 config.json 决定，否则成了先有鸡还是先有蛋。数据目录只认
 * AETHEROPS_DATA_DIR 环境变量与 ~/.aetherops 默认值（见 data-dir.ts）。
 */

export interface DatabaseConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  connectionLimit: number;
  connectTimeoutMs: number;
  charset: string;
  timezone: string;
  /** 是否启用 TLS。实测服务端支持 TLSv1.2/1.3，开关不影响可用性 */
  ssl: boolean;
  /**
   * 是否严格校验服务端证书。默认 false：Ubuntu 的 MySQL 发包时自动自签证书，
   * 没CA 的情况下严格校验连不上；此时连接仍然加密，但不防中间人。
   */
  sslRejectUnauthorized: boolean;
  /** CA 证书路径（可选）；填了就会用它做严格链校验 */
  sslCaPath: string;
}

export interface ServerConfig {
  port: number;
  host: string;
}

/**
 * Redis 配置。持有登录令牌（access token）——令牌不进 MySQL，
 * 因为需要按 TTL 自动过期，用库表做要额外扫表。
 */
export interface RedisConfig {
  /** 完整连接串，如 redis://:password@host:6379/0；填了它则忽略 host/port/password/username/db */
  url: string;
  host: string;
  port: number;
  /** Redis 6 ACL 用户名，单密码认证时留空 */
  username: string;
  /** 密码；留空表示无密码 */
  password: string;
  /** 逻辑库 0~15 */
  db: number;
  /** key 前缀；与其他业务共用同一实例时靠它隔离命名空间 */
  keyPrefix: string;
  connectTimeoutMs: number;
}

/** 实际生效的存储后端：enterprise = MySQL + Redis，lite = 单个 SQLite 文件 */
export type StorageMode = 'enterprise' | 'lite';

/**
 * 存储后端选择。
 *
 * 个人/单机部署不需要为了「存几条连接配置」去拉一套 MySQL + Redis；
 * lite 模式下业务数据与登录会话令牌全部落在一个 SQLite 文件里。
 *
 * 两种模式的数据结构互不兼容，不做自动搬运：切换后端等于换一套库，
 * 已有的 MySQL 数据不会自动导进 SQLite（见 docs/configuration.md）。
 */
export interface StorageConfig {
  /**
   * auto（默认）：配了 database.host / redis.host / redis.url 任一项就走 enterprise，
   * 全空则走 lite —— 这样老部署升级后行为不变，新装用户不填库也能直接跑。
   */
  mode: 'auto' | StorageMode;
  /** SQLite 文件路径；留空 = 数据目录下的 aetherops.db，相对路径按数据目录解析 */
  sqlitePath: string;
  /** SQLite 写锁等待上限（毫秒）。WAL 下并发写会短暂排队，超时才报 SQLITE_BUSY */
  busyTimeoutMs: number;
}

export interface AuthConfig {
  /** VSCode/Electron 宿主拉起服务端时的探活令牌（只用于 /health，不是用户身份） */
  launchToken: string;
  /** 单次上传体积上限（MB） */
  maxUploadMb: number;
  /**
   * 登录令牌有效期（秒），滑动续期。默认 7200（2 小时）。
   *
   * 需要“开着页面就不想再登录”的大屏/值班机，把监控令牌（watch token）比调这个更合适：
   * 调大它等于把所有端（包括手机、公用电脑）的会话一起延长。
   */
  tokenTtlSeconds: number;
  /**
   * 只读监控令牌的有效期（秒）。默认 2592000（30 天）。
   *
   * 它与登录会话不完全是一回事：只读、只认 /api/watch/*、不占「单账号单会话」的名额，
   * 吊销在界面里一键完成。零表示禁用签发。
   */
  watchTokenTtlSeconds: number;
}

export interface DebugConfig {
  /** 把 ssh2 协议级 debug 转发到前端终端 */
  sshDebug: boolean;
}

/**
 * 主机指标留存的行为开关。
 * 只放「会对外部产生可见副作用」的项：周期、保留期这类属于实现细节，
 * 写死在 host-metrics.service 里，免得配置项变成第二套默认值。
 */
export interface MetricsConfig {
  /**
   * 没有终端会话时是否也定时采集。
   *
   * 默认 false：打开后采集器会按连接配置**主动拨号**，目标机的 sshd 认证日志里
   * 每分钟会多出一条登录记录。这个副作用不该由升级本身决定，所以默认关、
   * 由部署者显式开启；单独某台机器不想被采，把该连接的 sampling 置为 'skip'。
   */
  offlineSampling: boolean;
}

export interface AppConfig {
  server: ServerConfig;
  storage: StorageConfig;
  database: DatabaseConfig;
  redis: RedisConfig;
  auth: AuthConfig;
  debug: DebugConfig;
  metrics: MetricsConfig;
  alerts: AlertsConfig;
}

/**
 * 告警投递（P5）。
 *
 * 只放「接收端与签名」这类部署者必须知道的东西；去抖窗口、重试退避是行为约定，
 * 写死在 alert-dispatcher 里 —— 做成配置项等于允许把 5 分钟改成 0 秒，
 * 而后者的效果是日志刷屏时把接收端打挂。
 */
export interface AlertsConfig {
  /** 群机器人 / 接收器地址；留空 = 只落库、不投递 */
  webhookUrl: string;
  /** HMAC-SHA256 密钥；留空 = 不签名（接收端无法校验来源） */
  webhookSecret: string;
  /** 单次投递超时（毫秒） */
  webhookTimeoutMs: number;
}

/**
 * 首次启动时落盘的默认配置。
 * 数据库账号密码留空是刻意的：空值会在启动探活时报「配置未完成」，
 * 比拿 127.0.0.1/root/空密码去连、失败后抛一堆底层错误更好读。
 */
const DEFAULTS: AppConfig = {
  server: {
    port: 9802,
    host: '127.0.0.1',
  },
  storage: {
    // auto：见 StorageConfig.mode 的注释
    mode: 'auto',
    // 留空落在数据目录（~/.aetherops/aetherops.db），随数据目录一起备份/迁移
    sqlitePath: '',
    busyTimeoutMs: 5000,
  },
  database: {
    host: '',
    port: 3306,
    user: '',
    password: '',
    database: 'aetherops',
    // 默认 5，不是原来的 10：实测目标实例 max_connections=50 且同时要服务多个其他业务，
    // 每个宿主实例吃 10 条连接很容易挤到别人头上。
    connectionLimit: 5,
    connectTimeoutMs: 10000,
    charset: 'utf8mb4',
    timezone: '+00:00',
    ssl: false,
    sslRejectUnauthorized: false,
    sslCaPath: '',
  },
  redis: {
    url: '',
    host: '',
    port: 6379,
    username: '',
    password: '',
    db: 0,
    // 前缀带冒号，拼 key 时直接 `${prefix}token:xxx`
    keyPrefix: 'aetherops:',
    connectTimeoutMs: 5000,
  },
  auth: {
    launchToken: '',
    maxUploadMb: 100,
    // 2 小时；续期阈值由它派生（ttl/4，上限 1000 秒），见 auth.service
    tokenTtlSeconds: 7200,
    // 30 天；只读大屏的默认寿命，与登录会话互不影响
    watchTokenTtlSeconds: 2592000,
  },
  debug: {
    sshDebug: false,
  },
  metrics: {
    // 默认关：见 MetricsConfig.offlineSampling 的注释
    offlineSampling: false,
  },
  alerts: {
    // 默认不投递：升级本身不该决定「把告警发到某个地址」
    webhookUrl: '',
    webhookSecret: '',
    webhookTimeoutMs: 5000,
  },
};

const CONFIG_FILENAME = 'config.json';
/** 显式指定配置文件路径的环境变量（容器/服务器场景挂只读配置用） */
export const CONFIG_PATH_ENV = 'AETHEROPS_CONFIG';

let cached: AppConfig | null = null;
let cachedPath: string | null = null;
let createdOnFirstRun = false;

/**
 * 定位配置文件。
 * AETHEROPS_CONFIG 指错了不存在的路径时必须报错，不能静默生成空模板：
 * 否则拼错一个字符就会得到「配置已加载但全是默认值」这种最难查的状态。
 */
function resolveConfigFile(): { file: string; explicit: boolean } {
  const explicit = (process.env[CONFIG_PATH_ENV] || '').trim();
  if (!explicit) return { file: getDataPath(CONFIG_FILENAME), explicit: false };
  const abs = path.isAbsolute(explicit) ? path.normalize(explicit) : path.resolve(process.cwd(), explicit);
  if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
    throw new Error(`${CONFIG_PATH_ENV} 指向的是目录而不是配置文件: ${abs}`);
  }
  return { file: abs, explicit: true };
}

/** 配置文件的绝对路径（默认在数据目录下，可被 AETHEROPS_CONFIG 覆盖） */
export function getConfigPath(): string {
  if (!cachedPath) cachedPath = resolveConfigFile().file;
  return cachedPath;
}

/** 配置文件里尚未被用户填写、必须由环境变量提供的项 */
export function getConfigFileStatus(): { path: string; exists: boolean; autoCreated: boolean; explicit: boolean } {
  const { file, explicit } = resolveConfigFile();
  return { path: file, exists: fs.existsSync(file), autoCreated: createdOnFirstRun, explicit };
}

function isPlainObject(value: any): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 已废弃的配置项：读到就丢掉并提示一次。
 * auth.disabled / auth.accessToken 属于旧的单令牌鉴权，现在身份只由账号体系给；
 * 留在配置文件里要么被当成「还能关鉴权」，要么在合并时刷一条看不懂的未知项警告。
 */
const DEPRECATED_KEYS: Record<string, string[]> = {
  auth: ['disabled', 'accessToken'],
};

function dropDeprecated(section: string, raw: any): any {
  const keys = DEPRECATED_KEYS[section];
  if (!keys || !isPlainObject(raw)) return raw;
  for (const key of keys) {
    if (key in raw) {
      console.warn(`[config] 配置项 ${section}.${key} 已废弃（鉴权改由账号体系负责），可手动删除`);
      delete raw[key];
    }
  }
  return raw;
}

/** 逐段深合并，只接受默认值里已存在的键，避免配置文件里的拼写错误悄悄生效 */
function mergeSection<T extends object>(base: T, override: any): T {
  if (!isPlainObject(override)) return { ...base };
  const out: any = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (!(key in out)) {
      console.warn(`[config] 忽略未知配置项: ${key}`);
      continue;
    }
    if (value === undefined || value === null) continue;
    // 默认值是 boolean/number/string 时才覆盖，嵌套对象整体按原样接受（当前配置无嵌套）
    if (isPlainObject(value)) {
      out[key] = mergeSection(out[key] as any, value);
    } else if (typeof value === typeof out[key]) {
      out[key] = value;
    } else if (typeof out[key] === 'number' && typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) {
      // 允许 JSON 里把端口写成 "3306" 这种手写常见的形式
      out[key] = Number(value);
    } else if (typeof out[key] === 'boolean' && typeof value === 'string') {
      out[key] = value === '1' || value.toLowerCase() === 'true';
    } else {
      console.warn(`[config] 配置项类型不符，按默认值处理: ${key}=${JSON.stringify(value)}`);
    }
  }
  return out as T;
}

/**
 * 环境变量覆盖。保留改造前已有的变量名（PORT / HOST / AETHEROPS_*），
 * 新增 AETHEROPS_DB_* 一组，便于 Docker / 反代场景不落盘密码。
 */
function applyEnvOverrides(config: AppConfig): AppConfig {
  const env = process.env;
  const num = (v: string | undefined) => (v === undefined || v === '' ? undefined : Number(v));
  const bool = (v: string | undefined) =>
    v === undefined || v === '' ? undefined : v === '1' || v.toLowerCase() === 'true';
  const str = (v: string | undefined) => (v === undefined ? undefined : v);

  const patches: Array<[string, string | number | boolean | undefined]> = [
    // 服务端只读 PORT（server.js: portFromArgs || process.env.PORT || 9802），不另造别名
    ['server.port', num(env.PORT)],
    ['server.host', str(env.HOST ?? env.AETHEROPS_HOST)],
    ['auth.launchToken', str(env.AETHEROPS_LAUNCH_TOKEN)],
    ['auth.maxUploadMb', num(env.AETHEROPS_MAX_UPLOAD_MB)],
    ['auth.tokenTtlSeconds', num(env.AETHEROPS_AUTH_TOKEN_TTL_SECONDS)],
    ['auth.watchTokenTtlSeconds', num(env.AETHEROPS_AUTH_WATCH_TOKEN_TTL_SECONDS)],
    ['debug.sshDebug', bool(env.AETHEROPS_SSH_DEBUG)],
    ['metrics.offlineSampling', bool(env.AETHEROPS_METRICS_OFFLINE_SAMPLING)],
    ['alerts.webhookUrl', str(env.AETHEROPS_ALERTS_WEBHOOK_URL)],
    ['alerts.webhookSecret', str(env.AETHEROPS_ALERTS_WEBHOOK_SECRET)],
    ['alerts.webhookTimeoutMs', num(env.AETHEROPS_ALERTS_WEBHOOK_TIMEOUT_MS)],
    ['storage.mode', str(env.AETHEROPS_STORAGE_MODE)],
    ['storage.sqlitePath', str(env.AETHEROPS_SQLITE_PATH)],
    ['storage.busyTimeoutMs', num(env.AETHEROPS_SQLITE_BUSY_TIMEOUT_MS)],
    ['database.host', str(env.AETHEROPS_DB_HOST)],
    ['database.port', num(env.AETHEROPS_DB_PORT)],
    ['database.user', str(env.AETHEROPS_DB_USER)],
    ['database.password', str(env.AETHEROPS_DB_PASSWORD)],
    ['database.database', str(env.AETHEROPS_DB_NAME)],
    ['database.connectionLimit', num(env.AETHEROPS_DB_POOL_SIZE)],
    ['database.ssl', bool(env.AETHEROPS_DB_SSL)],
    ['database.timezone', str(env.AETHEROPS_DB_TZ)],
    ['database.sslCaPath', str(env.AETHEROPS_DB_SSL_CA)],
    // 名为 INSECURE：置 true 表示关掉严格证书校验
    ['database.sslRejectUnauthorized', env.AETHEROPS_DB_SSL_INSECURE === undefined || env.AETHEROPS_DB_SSL_INSECURE === ''
      ? undefined
      : !bool(env.AETHEROPS_DB_SSL_INSECURE)],
    ['redis.url', str(env.AETHEROPS_REDIS_URL)],
    ['redis.host', str(env.AETHEROPS_REDIS_HOST)],
    ['redis.port', num(env.AETHEROPS_REDIS_PORT)],
    ['redis.username', str(env.AETHEROPS_REDIS_USER)],
    ['redis.password', str(env.AETHEROPS_REDIS_PASSWORD)],
    ['redis.db', num(env.AETHEROPS_REDIS_DB)],
    ['redis.keyPrefix', str(env.AETHEROPS_REDIS_PREFIX)],
    ['redis.connectTimeoutMs', num(env.AETHEROPS_REDIS_CONNECT_TIMEOUT_MS)],
  ];

  for (const [key, value] of patches) {
    if (value === undefined || value === '') continue;
    const [section, field] = key.split('.') as [keyof AppConfig, string];
    (config[section] as any)[field] = value;
  }

  return config;
}

function readConfigFile(file: string): Partial<Record<keyof AppConfig, any>> | null {
  if (!fs.existsSync(file)) return null;
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e: any) {
    throw new Error(`配置文件无法读取（${file}）: ${e.message}`);
  }
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (e: any) {
    // 这里绝不能吞掉：配置写坏还继续跑，等于用默认空数据库配置去连，报错会指向错误的方向
    throw new Error(`配置文件不是合法 JSON（${file}）: ${e.message}`);
  }
  if (!isPlainObject(parsed)) throw new Error(`配置文件顶层必须是对象（${file}）`);
  return parsed;
}

/** 顶层拼错的段名（比如把 database 写成 db）要吼一声，否则用户改了半天没反应 */
function warnUnknownSections(parsed: any): void {
  if (!isPlainObject(parsed)) return;
  for (const key of Object.keys(parsed)) {
    if (key === '_comment') continue;
    if (!(key in DEFAULTS)) {
      console.warn(`[config] 忽略未知配置段: ${key}（可用段：${Object.keys(DEFAULTS).join(' / ')}）`);
    }
  }
}

function writeDefaultConfig(file: string): void {
  // getDataDir() 只算路径不建目录，落盘前必须自己保证父目录存在
  ensureDataDir();
  const template = {
    ...DEFAULTS,
    storage: { ...DEFAULTS.storage },
    database: { ...DEFAULTS.database },
    redis: { ...DEFAULTS.redis },
  };
  const text = JSON.stringify(
    {
      _comment:
        'AetherOps 配置。storage.mode=auto 时：不填 database/redis 则用 SQLite 单文件（个人部署），填了则用 MySQL + Redis（企业部署）。环境变量可覆盖同名项。',
      ...template,
    },
    null,
    2
  );
  fs.writeFileSync(file, text, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* Windows 上 chmod 可能无效，忽略 */
  }
}

/** 配置合法性检查；返回人类可读的问题清单，供启动时一次性报全 */
export function validateConfig(config: AppConfig): string[] {
  const problems: string[] = [];
  const mode = resolveStorageMode(config);
  const db = config.database;

  if (!Number.isInteger(config.server.port) || config.server.port < 1 || config.server.port > 65535) {
    problems.push(`server.port 非法: ${config.server.port}`);
  }
  if (!Number.isFinite(config.auth.maxUploadMb) || config.auth.maxUploadMb <= 0) {
    problems.push(`auth.maxUploadMb 应大于 0: ${config.auth.maxUploadMb}`);
  }
  // 60 秒是下限：再短就不可能被“滑动续期”救回来（阈值取 ttl/4，一次轮询间隔内就过期）
  if (!Number.isInteger(config.auth.tokenTtlSeconds) || config.auth.tokenTtlSeconds < 60) {
    problems.push(`auth.tokenTtlSeconds 应为不小于 60 的整数: ${config.auth.tokenTtlSeconds}`);
  }
  if (!Number.isInteger(config.auth.watchTokenTtlSeconds) || config.auth.watchTokenTtlSeconds < 0) {
    problems.push(`auth.watchTokenTtlSeconds 应为不小于 0 的整数（0 = 禁止签发）: ${config.auth.watchTokenTtlSeconds}`);
  }

  const alerts = config.alerts;
  if (alerts.webhookUrl && !/^https?:\/\//i.test(alerts.webhookUrl)) {
    problems.push(`alerts.webhookUrl 必须是 http(s) 地址: ${alerts.webhookUrl}`);
  }
  if (alerts.webhookUrl && !alerts.webhookSecret) {
    // 不是错误：有些内部接收器本来就不校验来源。但必须吼一声，否则「以为签了」
    console.warn('[config] alerts.webhookUrl 已配置但 webhookSecret 为空：投递不带签名，接收端无法校验来源');
  }
  if (!Number.isFinite(alerts.webhookTimeoutMs) || alerts.webhookTimeoutMs < 1000) {
    problems.push(`alerts.webhookTimeoutMs 应不小于 1000: ${alerts.webhookTimeoutMs}`);
  }

  const storage = config.storage;
  if (storage.mode !== 'auto' && storage.mode !== 'enterprise' && storage.mode !== 'lite') {
    problems.push(`storage.mode 只支持 auto / enterprise / lite: ${storage.mode}`);
  }
  if (!Number.isFinite(storage.busyTimeoutMs) || storage.busyTimeoutMs < 0 || storage.busyTimeoutMs > 60000) {
    problems.push(`storage.busyTimeoutMs 应在 0~60000 之间: ${storage.busyTimeoutMs}`);
  }

  // MySQL / Redis 只在企业级后端下必需；lite 模式这两段整体不参与校验，
  // 否则「只想用 SQLite」的人会被一屏的 database.* 未配置拦截。
  if (mode === 'enterprise') {
    if (!db.host) problems.push('database.host 未配置');
    if (!db.user) problems.push('database.user 未配置');
    if (!db.database) problems.push('database.database 未配置（库名）');
    if (db.password === '') problems.push('database.password 未配置');
    if (!Number.isInteger(db.port) || db.port < 1 || db.port > 65535) problems.push(`database.port 非法: ${db.port}`);
    if (!Number.isInteger(db.connectionLimit) || db.connectionLimit < 1 || db.connectionLimit > 100) {
      problems.push(`database.connectionLimit 应在 1~100 之间: ${db.connectionLimit}`);
    }
    // TLS 相关：配了 CA 却没开 ssl 是常见的“我改了为何不生效”，直接当错误报出来
    if (db.sslCaPath && !db.ssl) problems.push('database.sslCaPath 已配置但 database.ssl 为 false，CA 不会生效');
    if (db.sslCaPath && !fs.existsSync(db.sslCaPath)) problems.push(`database.sslCaPath 指向的文件不存在: ${db.sslCaPath}`);
    if (db.ssl && db.sslRejectUnauthorized && !db.sslCaPath) {
      problems.push('database.ssl 与 sslRejectUnauthorized 同时开启但未提供 sslCaPath：服务端为自签证书时必定握手失败');
    }

    const redis = config.redis;
    if (!redis.url && !redis.host) problems.push('redis.host 未配置（或改用 redis.url 填完整连接串）');
    if (!Number.isInteger(redis.port) || redis.port < 1 || redis.port > 65535) problems.push(`redis.port 非法: ${redis.port}`);
    if (!Number.isInteger(redis.db) || redis.db < 0 || redis.db > 15) problems.push(`redis.db 应在 0~15 之间: ${redis.db}`);
    if (!redis.keyPrefix) problems.push('redis.keyPrefix 不能为空（为空时容易与其他业务 key 相撞）');
    if (!redis.url && redis.password === '') {
      // 不是错误，但有密码的实例漏填会让启动探活报 NOAUTH，先提示一句
      console.warn('[config] redis.password 为空，将按无密码连接；若实例开了 requirepass 请在配置里补上');
    }
  } else if (storage.mode === 'lite' && (db.host || config.redis.host || config.redis.url)) {
    // 显式指定了 lite 却又填了外部库：那不是错误，但两边的数据毫无关系，必须说清楚
    console.warn('[config] storage.mode=lite：database / redis 段将被忽略，连接配置、账号、审计与会话令牌全部落在 SQLite');
  }

  return problems;
}

/**
 * 读取并缓存配置。默认位置（数据目录下）首次调用时若文件不存在会自动落一份默认
 * 配置（权限 0600）并把路径提示到日志里，方便用户直接改。
 *
 * AETHEROPS_CONFIG 指定的文件不存在时直接抛错，不生成模板——显式指路就说明
 * 用户认为它存在，静默造一个空模板只会把问题推向「配了但没生效」的方向。
 *
 * @throws 配置文件损坏、或显式指定的文件不存在时抛错；是否阻塞启动由调用方决定，
 *         但缺数据库配置基本没法干活，所以启动流程应当直接失败。
 */
export function loadConfig(force = false): AppConfig {
  if (cached && !force) return cached;

  const { file, explicit } = resolveConfigFile();
  cachedPath = file;
  let fromFile: any = null;
  try {
    if (explicit) {
      if (!fs.existsSync(file)) {
        throw new Error(`${CONFIG_PATH_ENV} 指定的配置文件不存在: ${file}`);
      }
      fromFile = readConfigFile(file);
    } else {
      fromFile = readConfigFile(file);
      if (!fromFile) {
        writeDefaultConfig(file);
        createdOnFirstRun = true;
        console.warn(`[config] 未找到配置文件，已生成模板（权限 0600）: ${file}`);
        console.warn(
          '[config] 个人部署什么都不用改（storage.mode=auto → SQLite 单文件）；'
          + '要多机/多人共享数据就把 storage.mode 设为 enterprise 并填 database / redis 段'
          + '（或用 AETHEROPS_STORAGE_MODE / AETHEROPS_DB_* / AETHEROPS_REDIS_* 环境变量覆盖）。',
        );
        fromFile = {};
      }
    }
    warnUnknownSections(fromFile);
  } catch (e: any) {
    console.error(`[config] ${e.message}`);
    throw e;
  }

  const merged: AppConfig = {
    server: mergeSection(DEFAULTS.server, fromFile.server),
    storage: mergeSection(DEFAULTS.storage, fromFile.storage),
    database: mergeSection(DEFAULTS.database, fromFile.database),
    redis: mergeSection(DEFAULTS.redis, fromFile.redis),
    auth: mergeSection(DEFAULTS.auth, dropDeprecated('auth', fromFile.auth)),
    debug: mergeSection(DEFAULTS.debug, fromFile.debug),
    metrics: mergeSection(DEFAULTS.metrics, fromFile.metrics),
    alerts: mergeSection(DEFAULTS.alerts, fromFile.alerts),
  };

  cached = applyEnvOverrides(merged);
  return cached;
}

/** 供测试与「改配置后热重载」使用 */
export function resetConfigCache(): void {
  cached = null;
  cachedPath = null;
  createdOnFirstRun = false;
}

/** 打印用：抹掉所有敏感字段，避免密码进日志/前端 */
export function redactConfig(config: AppConfig = loadConfig()): any {
  const clone = JSON.parse(JSON.stringify(config));
  const mask = (v: string) => (v ? `${v.slice(0, 2)}***(${v.length} chars)` : '');
  clone.database.password = mask(clone.database.password);
  clone.database.user = clone.database.user || '';
  clone.redis.password = mask(clone.redis.password);
  if (clone.redis.url) clone.redis.url = mask(clone.redis.url);
  clone.auth.launchToken = mask(clone.auth.launchToken);
  clone.alerts.webhookSecret = mask(clone.alerts.webhookSecret);
  return clone;
}

/** 数据库连接摘要（不含密码），用于启动日志与「关于」面板 */
export function describeDatabase(target: DatabaseConfig = loadConfig().database): string {
  const host = target.host ? `${target.host}:${target.port}` : '(未配置)';
  return `${target.user || '(未配置)'}@${host}/${target.database}`;
}

/**
 * 解析实际生效的存储后端。
 * auto 下「只要配了任意一个外部依赖就当企业级」：老部署升级后 database.host
 * 通常已经在配置文件里，行为不会静默变成换库；新装用户什么都不填则直接拿到一张 SQLite。
 */
export function resolveStorageMode(config: AppConfig = loadConfig()): StorageMode {
  const mode = config.storage.mode;
  if (mode === 'enterprise' || mode === 'lite') return mode;
  const db = config.database;
  const redis = config.redis;
  return db.host || redis.host || redis.url ? 'enterprise' : 'lite';
}

/** SQLite 文件的绝对路径（已展开相对路径与默认值） */
export function getSqlitePath(config: AppConfig = loadConfig()): string {
  const raw = (config.storage.sqlitePath || '').trim();
  if (!raw) return getDataPath('aetherops.db');
  return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(getDataDir(), raw);
}

/** 存储后端摘要，用于启动日志 */
export function describeStorage(config: AppConfig = loadConfig()): string {
  const mode = resolveStorageMode(config);
  if (mode === 'lite') return `lite (SQLite) ${getSqlitePath(config)}`;
  const redis = config.redis;
  const redisTarget = redis.url ? 'url' : `${redis.host || '(未配置)'}:${redis.port}`;
  return `enterprise (MySQL + Redis) db=${describeDatabase(config.database)} redis=${redisTarget}`;
}
