import { ConnectionService } from './service/connection.service';
import { SSHService } from './service/ssh.service';
import { AIService } from './service/ai.service';
import { SkillService } from './service/skill.service';
import { AuditService } from './service/audit.service';
import { MonitorService } from './service/monitor.service';
import { BatchService } from './service/batch.service';
import { SnippetService } from './service/snippet.service';
import { initAccounts } from './routes/auth.routes';

// 初始化服务实例
const connectionService = new ConnectionService();
const sshService = new SSHService(connectionService);
const skillService = new SkillService();
const auditService = new AuditService();
const monitorService = new MonitorService(connectionService);
const batchService = new BatchService(sshService, connectionService);
const aiService = new AIService(sshService, skillService, auditService);
const snippetService = new SnippetService();

// 初始化
//
// 注意时机：这里没有在模块顶层调 init()。存储切到 MySQL 后，服务启动时要先
// 连库 + 跑迁移（server.js -> ensureDatabaseReady），才能读表。模块顶层执行时
// 表可能还不存在，所以改由 server.js 在库就绪后调用 initServices()，失败则不启动。
export async function initServices(): Promise<void> {
  console.log('[Server] Initializing services...');
  console.log(`[Server] Node version: ${process.version}, platform: ${process.platform}, arch: ${process.arch}`);
  console.log(`[Server] cwd: ${process.cwd()}`);
  console.log(`[Server] __dirname: ${__dirname}`);
  await connectionService.init();
  console.log('[Server] connectionService.init() completed');
  await sshService.init();
  await skillService.init();
  await auditService.init();
  await aiService.init();
  // 账号引导：users 表为空时创建 admin（密码只打启动日志一次）
  await initAccounts();
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
  | 'terminal' | 'ai' | 'connections' | 'aiConfig' | 'files'
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
  '/api/ai/getSkills': ['skills', 'ai'],
  '/api/ai/getSkill': ['skills', 'ai'],
};

const PREFIX_PERMISSIONS: Array<[string, PermissionKey[]]> = [
  ['/api/terminal/', ['terminal']],
  ['/api/file/', ['files', 'terminal']],
  ['/api/batch/', ['terminal']],
  ['/api/monitor/', ['monitor']],
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

    // ========== AI 配置 ==========

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
      const { sessionId, message, context } = body;
      if (!sessionId) throw Error('Missing parameter: sessionId');
      if (!message) throw Error('Missing parameter: message');
      return await aiService.chat(ownerId, sessionId, message, context);
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
