import { ConnectionService } from './service/connection.service';
import { SSHService, TRANSFER_AUDIT_TOOL } from './service/ssh.service';
import { AIService } from './service/ai.service';
import { SkillService } from './service/skill.service';
import { AuditService } from './service/audit.service';
import { FingerprintService } from './service/fingerprint.service';
import { AlertService } from './service/alert.service';
import { AlertDispatcher } from './service/alert-dispatcher';
import { MonitorService } from './service/monitor.service';
import { BatchService } from './service/batch.service';
import { SnippetService } from './service/snippet.service';
import { SystemStatusService } from './service/system-status.service';
import { HostMetricsService } from './service/host-metrics.service';
import { kickUser } from './service/auth.service';
import {
  clearServerShellPassword,
  getServerShellPasswordState,
  setServerShellPassword,
} from './service/server-shell.service';
import { closeTerminalSockets, countTerminalSockets } from './utils/socket-registry';
import { openSecretInput } from './utils/transport-crypto';
import { loadConfig } from './utils/config';
import { initAccounts } from './routes/auth.routes';

// 初始化服务实例
//
// 服务图挂在 globalThis 上，而不是模块作用域 —— 与 `db/pool.ts` / `db/redis.ts` 同因：
// dev（vite）改配置会重启，整个模块图重新求值一遍，`new XxxService()` 全部重来一份。
// 后果不只是连接翻倍：旧 hostMetricsService 的定时器还在跑（每分钟多采一轮），
// 旧 sshService 还挂着上一份实例的会话表与传输审计接线，而路由用的是新实例。
// 放到进程级后，重启复用同一套实例，initServices() 也只会真正初始化一次。
const SERVICES_KEY = Symbol.for('aetherops.server.serviceGraph');

interface ServiceGraph {
  connectionService: ConnectionService;
  sshService: SSHService;
  skillService: SkillService;
  auditService: AuditService;
  /** 错误指纹（P4）：跟审计一起挂在 agent 的 after_tool 上 */
  fingerprintService: FingerprintService;
  /** 告警（P5）：日志规则命中后落库、可确认、可投递 */
  alertService: AlertService;
  alertDispatcher: AlertDispatcher;
  monitorService: MonitorService;
  batchService: BatchService;
  systemStatusService: SystemStatusService;
  hostMetricsService: HostMetricsService;
  aiService: AIService;
  snippetService: SnippetService;
  /** 初始化只跑一次；失败时清空，允许宿主重试（dev 里库后起来是常态） */
  initPromise?: Promise<void>;
}

function createServiceGraph(): ServiceGraph {
  const connectionService = new ConnectionService();
  const sshService = new SSHService(connectionService);
  const skillService = new SkillService();
  const auditService = new AuditService();
  const fingerprintService = new FingerprintService();
  const monitorService = new MonitorService(connectionService);
  // 告警：监控只负责「这一行命中了规则」，去重/状态机/投递在 AlertService。
  // 配置在投递时才读（loadConfig 进程内缓存，改完要重启 —— 已写进 docs）。
  const alertDispatcher = new AlertDispatcher({ getConfig: () => loadConfig().alerts });
  const alertService = new AlertService(alertDispatcher);
  monitorService.setAlertSink((input) => { void alertService.recordFromMonitor(input); });
  const batchService = new BatchService(sshService, connectionService);
  // 顺序有依赖：采集器复用面板的状态采集（同一套口径）与连接配置（无会话采样要自己拨号），
  // AI 又要拿采集器查历史；后两个参数供 list_connections / run_on_hosts 用
  // （一个只读清单、一个复用批量执行），都只声明工具真正用到的那几个方法。
  const systemStatusService = new SystemStatusService(sshService);
  const hostMetricsService = new HostMetricsService(sshService, systemStatusService, connectionService);
  const aiService = new AIService(sshService, skillService, auditService, hostMetricsService, connectionService, batchService, fingerprintService);
  const snippetService = new SnippetService();

  // 传输审计：SSHService 不认识 AuditService，两个实例在这里接起来。
  // 写成注入而不是让 ssh.service 直接 import 审计实例：后者会把 index.ts 拽进一条
  // 循环依赖里，而且传输写入失败的归属判断（ownerId 从哪来）会失去唯一出口。
  sshService.setTransferLogger((record) => {
    void auditService.log(record.ownerId, {
      sessionId: record.sessionId,
      sessionName: record.sessionName,
      connectionId: record.connectionId,
      userMessage: record.direction === 'upload' ? '上传文件' : '下载文件',
      tool: TRANSFER_AUDIT_TOOL,
      command: `${record.direction === 'upload' ? 'UPLOAD' : 'DOWNLOAD'} ${record.path}`,
      result: record.ok ? `${record.bytes} bytes` : record.error,
      duration: record.durationMs,
      status: record.ok ? 'success' : 'error',
    });
  });

  return {
    connectionService,
    sshService,
    skillService,
    auditService,
    fingerprintService,
    alertService,
    alertDispatcher,
    monitorService,
    batchService,
    systemStatusService,
    hostMetricsService,
    aiService,
    snippetService,
  };
}

function serviceGraph(): ServiceGraph {
  const holder = globalThis as unknown as Record<symbol, ServiceGraph | undefined>;
  if (!holder[SERVICES_KEY]) holder[SERVICES_KEY] = createServiceGraph();
  return holder[SERVICES_KEY] as ServiceGraph;
}

const services = serviceGraph();
const connectionService = services.connectionService;
const sshService = services.sshService;
const skillService = services.skillService;
const auditService = services.auditService;
const fingerprintService = services.fingerprintService;
const alertService = services.alertService;
const monitorService = services.monitorService;
const batchService = services.batchService;
const systemStatusService = services.systemStatusService;
const hostMetricsService = services.hostMetricsService;
const aiService = services.aiService;
const snippetService = services.snippetService;

// 初始化
//
// 注意时机：这里没有在模块顶层调 init()。存储切到 MySQL 后，服务启动时要先
// 连库 + 跑迁移（server.js -> ensureDatabaseReady），才能读表。模块顶层执行时
// 表可能还不存在，所以改由 server.js 在库就绪后调用 initServices()，失败则不启动。
//
// 重复调用只跑一次（服务图在进程级，两个宿主先后调也共享同一份）：
// 没这道门，dev 重启会把同一批初始化再做一遍，定时器与订阅就多一套。
export async function initServices(): Promise<void> {
  if (services.initPromise) return services.initPromise;

  const started = (async () => {
    console.log('[Server] Initializing services...');
    console.log(`[Server] Node version: ${process.version}, platform: ${process.platform}, arch: ${process.arch}`);
    console.log(`[Server] cwd: ${process.cwd()}`);
    console.log(`[Server] __dirname: ${__dirname}`);
    await services.connectionService.init();
    console.log('[Server] connectionService.init() completed');
    await services.sshService.init();
    await services.skillService.init();
    await services.auditService.init();
    await services.fingerprintService.init();
    await services.alertService.init();
    await services.aiService.init();
    // 账号引导：users 表为空时创建 admin（密码只打启动日志一次）
    await initAccounts();
    // 指标留存：必须在库就绪之后（写 host_metrics_minute），且放最后——
    // 首轮采集本身延后 15s，不会和上面这些启动动作抢 SSH 通道
    services.hostMetricsService.start();
  })();
  services.initPromise = started;
  // 失败要允许重试：缓存一个 rejected 的 promise 等于让这个进程永远起不来
  started.catch(() => {
    if (services.initPromise === started) services.initPromise = undefined;
  });
  return started;
}

/**
 * 登录上下文：两种宿主（server.js / vite 中间件）把 authenticate() 的结果原样传进来。
 * 业务层不自己去读令牌——服务实例是全进程共享的，不存在「当前用户」这种概念。
 */
export interface AuthContext {
  userId: string;
  username: string;
  role: 'admin' | 'user';
  permissions: Record<string, boolean>;
}

/** 带 HTTP 状态码的错误：宿主据此回 401/403，而不是把权限问题都报成 500 */
export class ApiError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 500) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
  }
}

type PermissionKey =
  | 'terminal' | 'batch' | 'ai' | 'connections' | 'aiConfig' | 'files'
  | 'monitor' | 'audit' | 'skills' | 'snippets';

/**
 * 端点 → 所需权限（任一即可）。精确匹配优先，其次前缀匹配。
 *
 * 为什么是「任一」：文件管理与终端共用同一个 SSH 会话，
 * 有 files 没 terminal 的人也该能看文件，反之亦然。
 * 没登记的端点只要求登录就放行——漏登记的后果是「少拦」，
 * 而不是某个功能因为权限表笔误彻底不能用。
 */
const EXACT_PERMISSIONS: Record<string, PermissionKey[]> = {
  '/api/connection/getConnections': ['connections', 'terminal'],
  '/api/connection/getConnection': ['connections', 'terminal'],
  '/api/connection/addConnection': ['connections'],
  '/api/connection/updateConnection': ['connections'],
  '/api/connection/deleteConnection': ['connections'],
  '/api/connection/testConnection': ['connections'],
  '/api/ai/getConfig': ['aiConfig'],
  '/api/ai/updateConfig': ['aiConfig'],
  '/api/ai/testConfig': ['aiConfig'],
  '/api/ai/listProfiles': ['aiConfig'],
  '/api/ai/saveProfile': ['aiConfig'],
  '/api/ai/deleteProfile': ['aiConfig'],
  '/api/ai/testProfile': ['aiConfig'],
  '/api/ai/getSkills': ['skills', 'ai'],
  '/api/ai/getSkill': ['skills', 'ai'],
  // 技能自建（P6）：写自己的技能库，不碰别人的，也不碰内置技能文件
  '/api/ai/saveSkill': ['skills', 'ai'],
  '/api/ai/deleteSkill': ['skills', 'ai'],
};

const PREFIX_PERMISSIONS: Array<[string, PermissionKey[]]> = [
  ['/api/terminal/', ['terminal']],
  ['/api/file/', ['files', 'terminal']],
  // 批量操作单独一个权限位（不再跟 terminal 共用）：一条命令同时打到 N 台主机，
  // 影响面比单个终端大，管理员必须能只收回这一项。
  ['/api/batch/', ['batch']],
  ['/api/monitor/', ['monitor']],
  // 告警是监控的下游（规则命中后才产生），共用 monitor 权限位：
  // 能看日志的人当然能看它产生的告警，反之不成立。
  ['/api/alerts/', ['monitor']],
  ['/api/audit/', ['audit']],
  ['/api/snippet/', ['snippets']],
  ['/api/connection/', ['connections']],
  ['/api/ai/', ['ai']],
];

function assertPermission(pathname: string, ctx: AuthContext): void {
  const required = EXACT_PERMISSIONS[pathname]
    || PREFIX_PERMISSIONS.find(([prefix]) => pathname.startsWith(prefix))?.[1];
  if (!required) return;
  if (required.some((key) => !!ctx.permissions?.[key])) return;
  throw new ApiError('当前账号缺少权限：' + required.join(' / '), 403);
}

/**
 * 管理员代管端点：role=admin 才能进，与功能权限位无关。
 * 这是账号隔离的唯一例外，所以必须逐个端点显式校 role，
 * 而不是在 assertPermission 里登记一个「adminPermission」权限位。
 */
function assertAdmin(ctx: AuthContext): void {
  if (ctx.role !== 'admin') throw new ApiError('需要管理员权限', 403);
}

/** 代管端点的目标账号：缺这个参数就退化成「看自己」，宁可直接报错 */
function requireTargetUserId(body: any): string {
  const targetId = typeof body?.userId === 'string' ? body.userId.trim() : '';
  if (!targetId) throw new ApiError('缺少参数: userId', 400);
  return targetId;
}

/**
 * 管理员看别人的连接时只给定位信息。
 * 与 connection.service 里的 SECRET_FIELDS 保持同一份名单：口令、私钥、passphrase
 * 在任何「不是本人」的视图里都不能出现，否则代管就变成了凭据泄露。
 */
const MEMBER_SECRET_FIELDS = ['password', 'privateKey', 'passphrase'];

function stripSecrets(connection: any): any {
  const copy: any = { ...connection };
  let hasSecret = false;
  for (const field of MEMBER_SECRET_FIELDS) {
    if (copy[field]) hasSecret = true;
    delete copy[field];
  }
  copy.hasSecret = hasSecret;
  return copy;
}

/** 告警状态只能是我们认识的那三个；写错一个字母不能被当成「查全部」 */
const ALERT_STATUSES = ['open', 'acked', 'resolved'] as const;
function parseAlertStatus(value: any): 'open' | 'acked' | 'resolved' | '' {
  if (value === undefined || value === null || value === '') return '';
  const status = String(value);
  if (!(ALERT_STATUSES as readonly string[]).includes(status)) {
    throw new ApiError(`status 只能是 ${ALERT_STATUSES.join(' / ')}`, 400);
  }
  return status as 'open' | 'acked' | 'resolved';
}

function parseAlertId(value: any): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new ApiError('Missing parameter: id', 400);
  return id;
}

/** incident 状态只有两个；写错不能被当成「查全部」 */
const INCIDENT_STATUSES = ['open', 'resolved'] as const;
function parseIncidentStatus(value: any): 'open' | 'resolved' | '' {
  if (value === undefined || value === null || value === '') return '';
  const status = String(value);
  if (!(INCIDENT_STATUSES as readonly string[]).includes(status)) {
    throw new ApiError(`status 只能是 ${INCIDENT_STATUSES.join(' / ')}`, 400);
  }
  return status as 'open' | 'resolved';
}

/**
 * 会话归属守卫。
 * 终端 sessionId 由前端生成，猜到别人的 id 就能读写对方终端，
 * 所以所有带 sessionId 的接口在入口统一校一次，而不是逐个路由记得写。
 * 不存在的 session 放行（AI 历史等场景的 sessionId 未必是终端会话），
 * 真正碰终端时 getSession 会自己失败。
 */
function assertSessionOwner(ctx: AuthContext, body: any): void {
  const sessionId = body && typeof body.sessionId === 'string' ? body.sessionId : '';
  if (!sessionId) return;
  const owner = sshService.getSessionOwner(sessionId);
  if (owner && owner !== ctx.userId) {
    throw new ApiError('禁止访问其他账号的会话', 403);
  }
}

/**
 * REST API 路由处理
 * 所有 API 请求通过此函数统一分发；第三个参数是当前登录人，
 * 每个仓储/服务调用都必须带 ownerId，不能靠「服务实例里记住上一个用户」。
 */
export async function handleRoutes(pathname: string, body: any, ctx: AuthContext) {
  console.log(`[Server] handleRoutes: ${pathname} user=${ctx?.username || '-'}`);
  const ownerId = ctx?.userId;
  if (!ownerId) throw new ApiError('Unauthorized', 401);
  assertPermission(pathname, ctx);
  assertSessionOwner(ctx, body);
  try {
    // ========== 系统设置（全局配置；写操作仅管理员） ==========

    // 「默认服务器 Shell」口令状态。不登记到权限表：assertAdmin 已把非管理员挡住，
    // 再挂一个功能权限位会让「停掉 terminal 权限」反而能改主机口令。
    if (pathname === '/api/system/getServerShell') {
      assertAdmin(ctx);
      return await getServerShellPasswordState();
    }

    if (pathname === '/api/system/setServerShellPassword') {
      assertAdmin(ctx);
      // 口令必须是密文：这个终端开在服务端主机上，链路上被抓到明文等于主机交给对方
      let password = '';
      try {
        password = openSecretInput(body?.password, 'password');
      } catch (e: any) {
        throw new ApiError(e?.message || '口令必须以密文传输', 400);
      }
      await setServerShellPassword(password);
      console.log(`[Admin] ${ctx.username} 已更新默认服务器 Shell 口令`);
      return true;
    }

    // 清除后不是免密，而是谁都打不开，需要管理员重新设置
    if (pathname === '/api/system/clearServerShellPassword') {
      assertAdmin(ctx);
      const removed = await clearServerShellPassword();
      console.log(`[Admin] ${ctx.username} 已清除默认服务器 Shell 口令（影响 ${removed} 条记录）`);
      return removed;
    }

    // ========== 连接管理 ==========

    // 获取所有连接
    if (pathname === '/api/connection/getConnections') {
      return await connectionService.getAllConnections(ownerId);
    }

    // 获取单个连接
    if (pathname === '/api/connection/getConnection') {
      const { id } = body;
      if (!id) throw Error('Missing parameter: id');
      return await connectionService.getConnectionById(ownerId, id);
    }

    // 添加连接
    if (pathname === '/api/connection/addConnection') {
      return await connectionService.addConnection(ownerId, body);
    }

    // 更新连接
    if (pathname === '/api/connection/updateConnection') {
      const { id, ...updates } = body;
      if (!id) throw Error('Missing parameter: id');
      return await connectionService.updateConnection(ownerId, id, updates);
    }

    // 删除连接
    if (pathname === '/api/connection/deleteConnection') {
      const { id } = body;
      if (!id) throw Error('Missing parameter: id');
      await connectionService.deleteConnection(ownerId, id);
      return true;
    }

    // 测试连接（只拨号，不读库，所以不需要 owner）
    if (pathname === '/api/connection/testConnection') {
      return await connectionService.testConnection(body);
    }

    // ========== 终端管理（REST 部分，WebSocket 在 server.js 处理） ==========

    // 获取活跃会话列表
    if (pathname === '/api/terminal/getSessions') {
      return sshService.getSessions(ownerId);
    }

    // 重命名会话
    if (pathname === '/api/terminal/renameSession') {
      const { sessionId, name } = body;
      if (!sessionId) throw Error('Missing parameter: sessionId');
      sshService.renameSession(sessionId, name);
      return true;
    }

    // 删除会话（从 server 端移除 metadata）
    if (pathname === '/api/terminal/deleteSession') {
      const { sessionId } = body;
      if (!sessionId) throw Error('Missing parameter: sessionId');
      await sshService.deleteSession(sessionId, ownerId);
      return true;
    }

    // 关闭指定会话
    if (pathname === '/api/terminal/closeSession') {
      const { sessionId } = body;
      if (!sessionId) throw Error('Missing parameter: sessionId');
      sshService.closeSession(sessionId);
      return true;
    }

    // 关闭当前账号的所有会话（不能把别人的终端一起关掉）
    if (pathname === '/api/terminal/closeAllSessions') {
      sshService.closeAllSessions(ownerId);
      return true;
    }

    // 采集会话所在主机的实时状态（CPU / 内存 / Swap / 磁盘 / 网络）
    if (pathname === '/api/terminal/getServerStatus') {
      const { sessionId } = body;
      if (!sessionId) throw Error('Missing parameter: sessionId');
      return await systemStatusService.collect(sessionId);
    }

    // ========== AI 配置（多套模型） ==========

    // 列出全部模型配置
    if (pathname === '/api/ai/listProfiles') {
      return await aiService.listProfiles(ownerId);
    }

    // 新增或保存一套模型配置（无 id 即新增）
    if (pathname === '/api/ai/saveProfile') {
      return await aiService.saveProfile(ownerId, body);
    }

    // 删除一套模型配置
    if (pathname === '/api/ai/deleteProfile') {
      const { id } = body;
      if (!id) throw Error('Missing parameter: id');
      await aiService.deleteProfile(ownerId, id);
      return true;
    }

    // 试连一套模型配置（可传未保存的表单值）
    if (pathname === '/api/ai/testProfile') {
      return await aiService.testProfile(ownerId, body);
    }

    // ========== 对话窗口（与连接绑定） ==========

    // 列出对话：传 connectionId 就只返回该连接下的
    if (pathname === '/api/ai/listChats') {
      const connectionId = typeof body?.connectionId === 'string' ? body.connectionId : '';
      return await aiService.listChats(ownerId, connectionId || undefined);
    }

    // 单个对话元数据
    if (pathname === '/api/ai/getChat') {
      const { chatId } = body;
      if (!chatId) throw Error('Missing parameter: chatId');
      return await aiService.getChat(ownerId, chatId);
    }

    // 新建对话
    if (pathname === '/api/ai/createChat') {
      return await aiService.createChat(ownerId, body || {});
    }

    // 重命名对话 / 切换该对话记住的模型
    if (pathname === '/api/ai/updateChat') {
      const { chatId, title, modelId } = body || {};
      if (!chatId) throw Error('Missing parameter: chatId');
      return await aiService.updateChat(ownerId, chatId, { title, modelId });
    }

    // 删除对话（连带消息体）
    if (pathname === '/api/ai/deleteChat') {
      const { chatId } = body;
      if (!chatId) throw Error('Missing parameter: chatId');
      await aiService.deleteChat(ownerId, chatId);
      return true;
    }

    // ========== 成本管控 ==========

    // 重算全部档位与单价（用户主动点击时才等定价目录）
    if (pathname === '/api/ai/reanalyzeCosts') {
      return await aiService.reanalyzeCosts(ownerId);
    }

    // 只体检不写库（设置页打开时调用，不等网络）
    if (pathname === '/api/ai/checkupCosts') {
      return await aiService.checkupCosts(ownerId);
    }

    // 用量与成本洞察（今日 / 单对话 / 按模型 / auto 节省估算）
    if (pathname === '/api/ai/getCostInsights') {
      const chatId = typeof body?.chatId === 'string' ? body.chatId : '';
      return await aiService.getCostInsights(ownerId, { chatId: chatId || undefined });
    }

    // 预算（0 一律表示不限）
    if (pathname === '/api/ai/getBudget') {
      return await aiService.getBudget(ownerId);
    }

    if (pathname === '/api/ai/updateBudget') {
      return await aiService.updateBudget(ownerId, body || {});
    }

    // ========== AI 配置（旧接口，保留兼容） ==========

    // 获取 AI 配置
    if (pathname === '/api/ai/getConfig') {
      return await aiService.getConfig(ownerId);
    }

    // 更新 AI 配置
    if (pathname === '/api/ai/updateConfig') {
      return await aiService.updateConfig(ownerId, body);
    }

    // 测试 AI 配置
    if (pathname === '/api/ai/testConfig') {
      return await aiService.testConfig(ownerId, body);
    }

    // AI 对话（非流式）
    if (pathname === '/api/ai/chat') {
      const { sessionId, message, context, modelId } = body;
      if (!sessionId) throw Error('Missing parameter: sessionId');
      if (!message) throw Error('Missing parameter: message');
      return await aiService.chat(ownerId, sessionId, message, context, modelId);
    }

    // 清空 AI 对话历史
    if (pathname === '/api/ai/clearHistory') {
      const { sessionId } = body;
      if (!sessionId) throw Error('Missing parameter: sessionId');
      await aiService.clearHistory(ownerId, sessionId);
      return true;
    }

    // 获取 Session 的系统环境信息
    if (pathname === '/api/ai/getSystemContext') {
      const { sessionId } = body;
      if (!sessionId) throw Error('Missing parameter: sessionId');
      return await sshService.getSystemContext(sessionId);
    }

    // 获取 AI 对话显示历史（前端恢复用）
    if (pathname === '/api/ai/getDisplayHistory') {
      const { sessionId } = body;
      if (!sessionId) throw Error('Missing parameter: sessionId');
      return aiService.loadDisplayHistory(ownerId, sessionId);
    }

    // 保存 AI 对话显示历史
    if (pathname === '/api/ai/saveDisplayHistory') {
      const { sessionId, messages, sessionName } = body;
      if (!sessionId) throw Error('Missing parameter: sessionId');
      if (!messages) throw Error('Missing parameter: messages');
      await aiService.saveDisplayHistory(ownerId, sessionId, messages, sessionName);
      return true;
    }

    // 列出所有历史对话（仅元数据）
    if (pathname === '/api/ai/listHistories') {
      return aiService.listDisplayHistories(ownerId);
    }

    // 加载指定历史对话的完整消息
    if (pathname === '/api/ai/loadHistory') {
      const { sessionId } = body;
      if (!sessionId) throw Error('Missing parameter: sessionId');
      return aiService.loadDisplayHistory(ownerId, sessionId);
    }

    // 删除指定历史对话
    if (pathname === '/api/ai/deleteHistory') {
      const { sessionId } = body;
      if (!sessionId) throw Error('Missing parameter: sessionId');
      await aiService.deleteDisplayHistoryFile(ownerId, sessionId);
      return true;
    }

    // 获取 Skills 列表
    if (pathname === '/api/ai/getSkills') {
      return await skillService.getSkills(ownerId);
    }

    // 获取指定 Skill
    if (pathname === '/api/ai/getSkill') {
      const { id } = body;
      if (!id) throw Error('Missing parameter: id');
      const skill = await skillService.getSkill(ownerId, id);
      if (!skill) throw Error('Skill not found: ' + id);
      return skill;
    }

    // 新建/更新用户技能（P6）：校验在 SkillService 里，这里只收参数
    if (pathname === '/api/ai/saveSkill') {
      try {
        return await skillService.saveUserSkill(ownerId, {
          id: body?.id,
          name: body?.name,
          description: body?.description,
          tags: body?.tags,
          content: body?.content,
        });
      } catch (e: any) {
        // 校验失败是参数问题（400），不要报成 500 让前端以为服务挂了
        throw new ApiError(e?.message || '保存技能失败', 400);
      }
    }

    // 删除用户技能：只能删自己的；内置技能不在库里，删不到
    if (pathname === '/api/ai/deleteSkill') {
      const id = typeof body?.id === 'string' ? body.id.trim().toLowerCase() : '';
      if (!id) throw new ApiError('Missing parameter: id', 400);
      const removed = await skillService.deleteUserSkill(ownerId, id);
      if (!removed) throw new ApiError('技能不存在或属于内置技能', 404);
      return true;
    }

    // ========== 审计日志 ==========

    // 查询审计日志
    if (pathname === '/api/audit/list') {
      return await auditService.getLogs(ownerId, body);
    }

    // 获取审计统计
    if (pathname === '/api/audit/stats') {
      return await auditService.getStats(ownerId, body?.date);
    }

    // 导出审计日志
    if (pathname === '/api/audit/export') {
      const { startDate, endDate, format } = body;
      if (!startDate || !endDate) throw Error('Missing parameters: startDate, endDate');
      return await auditService.exportLogs(ownerId, startDate, endDate, format || 'json');
    }

    // 获取可用审计日期列表
    if (pathname === '/api/audit/dates') {
      return await auditService.getAvailableDates(ownerId);
    }

    // ========== 命令片段 ==========

    // 列出命令片段
    if (pathname === '/api/snippet/list') {
      return await snippetService.list(ownerId);
    }

    // 新建或更新片段
    if (pathname === '/api/snippet/save') {
      return await snippetService.save(ownerId, body);
    }

    // 删除片段
    if (pathname === '/api/snippet/delete') {
      const { id } = body;
      if (!id) throw Error('Missing parameter: id');
      await snippetService.remove(ownerId, id);
      return true;
    }

    // ========== 日志监控 ==========

    // 启动日志监控
    if (pathname === '/api/monitor/start') {
      const { sessionId, connectionId, logPath, pattern } = body;
      if (!sessionId || !logPath) throw Error('Missing parameters: sessionId, logPath');
      return await monitorService.startMonitor(ownerId, sessionId, connectionId || '', logPath, pattern);
    }

    // 停止日志监控
    if (pathname === '/api/monitor/stop') {
      const { monitorId } = body;
      if (!monitorId) throw Error('Missing parameter: monitorId');
      return monitorService.stopMonitor(ownerId, monitorId);
    }

    // 获取活跃监控列表
    if (pathname === '/api/monitor/list') {
      return monitorService.getActiveMonitors(ownerId, body?.sessionId);
    }

    // 获取监控告警
    if (pathname === '/api/monitor/alerts') {
      const { monitorId, limit } = body;
      if (!monitorId) throw Error('Missing parameter: monitorId');
      return monitorService.getAlerts(ownerId, monitorId, limit);
    }

    // 获取监控最近行
    if (pathname === '/api/monitor/lines') {
      const { monitorId, limit } = body;
      if (!monitorId) throw Error('Missing parameter: monitorId');
      return monitorService.getRecentLines(ownerId, monitorId, limit);
    }

    // 获取监控批量行（供 AI 分析）
    if (pathname === '/api/monitor/analyze') {
      const { monitorId } = body;
      if (!monitorId) throw Error('Missing parameter: monitorId');
      return monitorService.getBatchForAnalysis(ownerId, monitorId);
    }

    // ========== 告警（P5：离开页面的告警） ==========

    // 列表 + 按状态计数
    if (pathname === '/api/alerts/list') {
      const status = parseAlertStatus(body?.status);
      return await alertService.list(ownerId, {
        status,
        connectionId: typeof body?.connectionId === 'string' ? body.connectionId.trim() : undefined,
        limit: body?.limit,
        offset: body?.offset,
      });
    }

    // 确认（open → acked）：已确认/已解决的重复点按返回 409，让前端刷新而不是假装成功
    if (pathname === '/api/alerts/ack') {
      const id = parseAlertId(body?.id);
      const updated = await alertService.ack(ownerId, id, ctx.userId);
      if (!updated) throw new ApiError('告警不存在或已不是待确认状态', 409);
      return updated;
    }

    // 标记已解决（open/acked → resolved）
    if (pathname === '/api/alerts/resolve') {
      const id = parseAlertId(body?.id);
      const updated = await alertService.resolve(ownerId, id);
      if (!updated) throw new ApiError('告警不存在或已解决', 409);
      return updated;
    }

    // 当前生效的规则级静默窗口
    if (pathname === '/api/alerts/mutes') {
      return await alertService.mutes(ownerId);
    }

    // 静默某条规则 N 分钟（默认 60 分钟，上限 7 天）
    if (pathname === '/api/alerts/mute') {
      const rule = typeof body?.rule === 'string' ? body.rule : '';
      if (!rule.trim()) throw Error('Missing parameter: rule');
      const minutes = body?.minutes === undefined ? 60 : Number(body.minutes);
      return await alertService.mute(ownerId, rule, minutes);
    }

    // 取消静默
    if (pathname === '/api/alerts/unmute') {
      const rule = typeof body?.rule === 'string' ? body.rule : '';
      if (!rule.trim()) throw Error('Missing parameter: rule');
      return await alertService.unmute(ownerId, rule);
    }

    // ========== 告警协同（P6：认领 / 值班 / 事件归并） ==========

    // 认领 = 确认 + 指派给自己（已解决 → 409）
    if (pathname === '/api/alerts/claim') {
      const id = parseAlertId(body?.id);
      const updated = await alertService.claim(ownerId, id, ctx.userId);
      if (!updated) throw new ApiError('告警不存在或已解决', 409);
      return updated;
    }

    // 转派 / 取消指派（assigneeId 传空表示清空）
    if (pathname === '/api/alerts/assign') {
      const id = parseAlertId(body?.id);
      const assigneeId = typeof body?.assigneeId === 'string' ? body.assigneeId : '';
      try {
        const updated = await alertService.assign(ownerId, id, assigneeId);
        if (!updated) throw new ApiError('告警不存在或已解决', 409);
        return updated;
      } catch (e: any) {
        // 服务层只在这里抛「成员不存在」，转成 400 让前端能提示而不是当 500
        if (/member/i.test(e?.message || '')) throw new ApiError(e.message, 400);
        throw e;
      }
    }

    // 可指派成员（只有 id / username / displayName）
    if (pathname === '/api/alerts/members') {
      return await alertService.members();
    }

    // 值班表：只影响 webhook 里的 onCall，不建通知渠道
    if (pathname === '/api/alerts/oncall') {
      return await alertService.onCall(ownerId);
    }

    if (pathname === '/api/alerts/setOncall') {
      try {
        return await alertService.setOnCall(ownerId, body?.userId, body?.startMinute, body?.endMinute);
      } catch (e: any) {
        // 时间窗参数错（不在 0-1439 / 长度为 0 / 成员不存在）都是参数问题，不能报成 500
        throw new ApiError(e?.message || '保存值班时间窗失败', 400);
      }
    }

    if (pathname === '/api/alerts/clearOncall') {
      try {
        return await alertService.clearOnCall(ownerId, body?.userId, body?.startMinute);
      } catch (e: any) {
        throw new ApiError(e?.message || '删除值班时间窗失败', 400);
      }
    }

    // 事件列表（规则版归并的结果）
    if (pathname === '/api/alerts/incidents') {
      const status = parseIncidentStatus(body?.status);
      return await alertService.incidents(ownerId, { status, limit: body?.limit });
    }

    // 人工关联：并进同主机仍然活跃的事件（没有就新建）
    if (pathname === '/api/alerts/attachIncident') {
      const id = parseAlertId(body?.id);
      const result = await alertService.attachIncident(ownerId, id);
      if (!result) throw new ApiError('告警不存在', 404);
      return result;
    }

    // ========== 批量操作 ==========

    // 执行批量命令
    if (pathname === '/api/batch/execute') {
      const { sessionIds, command, timeout } = body;
      if (!sessionIds || !Array.isArray(sessionIds) || sessionIds.length === 0) {
        throw Error('Missing parameter: sessionIds (non-empty array)');
      }
      if (!command) throw Error('Missing parameter: command');
      return await batchService.executeBatch(ownerId, sessionIds, command, timeout);
    }

    // 获取批量任务结果
    if (pathname === '/api/batch/result') {
      const { taskId } = body;
      if (!taskId) throw Error('Missing parameter: taskId');
      return batchService.getTask(ownerId, taskId);
    }

    // 获取所有批量任务
    if (pathname === '/api/batch/tasks') {
      return batchService.getTasks(ownerId);
    }

    // ========== 管理员代管（只看 role=admin，看的是「别人」的数据） ==========
    //
    // 这一组端点是账号隔离的唯一例外，所以三条约束必须同时成立：
    //   1. 入口先 assertAdmin，不靠功能权限位（role 与权限位本来就是两件事）；
    //   2. 目标账号 id 只能来自参数 userId，绝不从当前登录人推；
    //   3. 只给读与「删连接 / 断会话」这两类应急处置，不提供改内容、不提供碰对方终端。

    if (pathname === '/api/admin/memberAudit') {
      assertAdmin(ctx);
      const targetId = requireTargetUserId(body);
      return await auditService.getLogs(targetId, {
        date: body?.date,
        sessionId: body?.sessionId,
        keyword: body?.keyword,
        status: body?.status,
        tool: body?.tool,
        limit: body?.limit,
        offset: body?.offset,
      });
    }

    if (pathname === '/api/admin/memberAuditDates') {
      assertAdmin(ctx);
      return await auditService.getAvailableDates(requireTargetUserId(body));
    }

    // 传输记录：审计里 tool=file-transfer 的那一类（方向 / 路径 / 字节数 / 成败）
    if (pathname === '/api/admin/memberTransfers') {
      assertAdmin(ctx);
      const targetId = requireTargetUserId(body);
      return await auditService.getLogs(targetId, {
        date: body?.date,
        keyword: body?.keyword,
        status: body?.status,
        tool: TRANSFER_AUDIT_TOOL,
        limit: body?.limit,
        offset: body?.offset,
      });
    }

    // 成员连接：只读，且凭据一律不下发
    if (pathname === '/api/admin/memberConnections') {
      assertAdmin(ctx);
      const list = await connectionService.getAllConnections(requireTargetUserId(body));
      return list.map(stripSecrets);
    }

    if (pathname === '/api/admin/deleteMemberConnection') {
      assertAdmin(ctx);
      const targetId = requireTargetUserId(body);
      const { id } = body;
      if (!id) throw Error('Missing parameter: id');
      await connectionService.deleteConnection(targetId, id);
      return true;
    }

    // 成员当前在线会话：紧急断开前得看到「他确实还挂着几个终端」
    if (pathname === '/api/admin/memberSessions') {
      assertAdmin(ctx);
      const targetId = requireTargetUserId(body);
      return {
        sessions: sshService.getSessions(targetId),
        sockets: countTerminalSockets(targetId),
      };
    }

    // 紧急断开：会话进程 + tab 记录 + WebSocket + 登录令牌一起收。
    // 只关进程不删行，对方刷新页面就能把 tab 建回来；只删行不吊销令牌，
    // 他当场点「重连」又能拉一个会话，两者都不是应急想要的效果。
    if (pathname === '/api/admin/disconnectUser') {
      assertAdmin(ctx);
      const targetId = requireTargetUserId(body);
      const closedSessions = await sshService.forceDisconnectUser(targetId);
      const closedSockets = closeTerminalSockets(targetId, '管理员已强制断开该账号的终端连接');
      await kickUser(targetId);
      console.log(`[Admin] ${ctx.username} 紧急断开账号 ${targetId}: 会话 ${closedSessions} 个, socket ${closedSockets} 条`);
      return { closedSessions, closedSockets };
    }

    // ========== 文件管理（SFTP / 本地 fs） ==========

    // 列出目录内容
    if (pathname === '/api/file/list') {
      const { sessionId, path: remotePath } = body;
      if (!sessionId) throw Error('Missing parameter: sessionId');
      return await sshService.listDirectory(sessionId, remotePath || '/');
    }

    // 创建目录
    if (pathname === '/api/file/mkdir') {
      const { sessionId, path: remotePath } = body;
      if (!sessionId || !remotePath) throw Error('Missing parameter: sessionId, path');
      await sshService.makeDirectory(sessionId, remotePath);
      return true;
    }

    // 删除文件或目录
    if (pathname === '/api/file/remove') {
      const { sessionId, path: remotePath } = body;
      if (!sessionId || !remotePath) throw Error('Missing parameter: sessionId, path');
      await sshService.removePath(sessionId, remotePath);
      return true;
    }

    // 重命名 / 移动
    if (pathname === '/api/file/rename') {
      const { sessionId, oldPath, newPath } = body;
      if (!sessionId || !oldPath || !newPath) throw Error('Missing parameter: sessionId, oldPath, newPath');
      await sshService.renamePath(sessionId, oldPath, newPath);
      return true;
    }

    // 获取会话默认目录（home）
    if (pathname === '/api/file/defaultDir') {
      const { sessionId } = body;
      if (!sessionId) throw Error('Missing parameter: sessionId');
      return await sshService.getDefaultDirectory(sessionId);
    }

    throw Error('API endpoint not found');
  } catch (error: any) {
    if (error?.detail) error.message += ' ' + error.detail;
    throw error;
  }
}

// 导出服务实例供 WebSocket 使用
export { connectionService, sshService, aiService, skillService, auditService, monitorService, batchService, snippetService };
