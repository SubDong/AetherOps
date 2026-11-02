import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';
import { getDataPath } from '../utils/data-dir';
import { AuditService } from './audit.service';
import { assessDangerousCommand } from '../utils/shell';
import {
  AgentEngine, ToolRegistry, ContextManager, SecurityGuard,
  createLLMProvider,
} from '@cicctencent/agent-core';
import type {
  LLMProvider, AgentEvent as CoreAgentEvent,
  Message, ToolContext, ToolDefinition,
} from '@cicctencent/agent-core';
import { extractTextFromContent } from '@cicctencent/agent-core';
import {
  loadAIConfigRow, saveAIConfigRow, listAIConfigRows, deleteAIConfigRow, DEFAULT_AI_CONFIG_ID,
} from '../db/repositories/ai-config.repo';
import {
  insertChatRow, listChatRows, loadChatRow, updateChatRow, deleteChatRow,
} from '../db/repositories/ai-chat.repo';
import type { AIChatRow } from '../db/repositories/ai-chat.repo';
import { scoreTaskComplexity, rankProfilesForTier, describeAutoRoute } from './ai-auto-router';
import type { AutoRouteDecision, AutoRouteInput, ModelHealthStat } from './ai-auto-router';
import { analyzeProfiles, estimateCostUsd } from './ai-cost-analyzer';
import type { CostAnalysisResult, CostTierInput } from './ai-cost-analyzer';
import { prefetchCatalog, lookupPrice } from './ai-pricing';
import {
  insertUsageRow, sumUsage, groupUsageByModel, groupUsageByChat,
  loadModelHealth, deleteUsageByChat, startOfToday,
} from '../db/repositories/ai-usage.repo';
import type { UsageTotals } from '../db/repositories/ai-usage.repo';
import { loadBudgetRow, saveBudgetRow } from '../db/repositories/ai-budget.repo';
import type { AIBudgetRow } from '../db/repositories/ai-budget.repo';
import {
  saveHistory, loadHistoryMessages, listHistories, deleteHistory,
} from '../db/repositories/ai-history.repo';
import {
  saveChatMessages as saveChatMessagesRow,
  loadChatMessages as loadChatMessagesRow,
  deleteChatMessages as deleteChatMessagesRow,
} from '../db/repositories/ai-messages.repo';

const ENCRYPTED_PREFIX = 'enc:v1:';

// ========== 公共导出类型 ==========

export interface AIConfig {
  enabled: boolean;
  provider: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  maxTokens?: number;
  temperature?: number;
}

/** 一套模型配置：id/label 是多配置管理需要的，AIConfig 只描述「怎么调这个模型」 */
export interface AIProfile extends AIConfig {
  id: string;
  label: string;
  /** 1=最便宜 … 5=最强，auto 路由按它分档 */
  costTier: number;
  /** auto=由定价目录/规则推断（允许重算），manual=用户手填（不再自动覆盖） */
  costTierSource?: 'auto' | 'manual';
  /** 美元 / 1M token；null=定价目录里没查到，不做金额估算 */
  priceIn?: number | null;
  priceOut?: number | null;
  sortOrder: number;
}

/** 'auto' 是虚拟配置：不出现在 ai_config 表里，由路由实时决定用哪个 */
export const AUTO_MODEL_ID = 'auto';

/** 一个账号下最多几套模型配置：只是防手滑，不是产品限制 */
const MAX_PROFILES = 20;
/** auto 模式下最多向下试探几个模型（含第一个）：1 次首选 + 2 次降级 */
const MAX_AUTO_ATTEMPTS = 3;

/** 对话窗口元数据（与终端会话解耦，绑定 connectionId） */
export interface AIChatMeta {
  id: string;
  connectionId: string;
  title: string;
  modelId: string;
  messageCount: number;
  preview: string;
  createdAt: number;
  updatedAt: number;
  /** 该对话累计 token（列表页展示，未统计过为 0） */
  totalTokens?: number;
  /** 该对话累计金额（美元）；单价未知的调用不进去，所以是下限 */
  costUsd?: number;
}

export interface AgentRunOptions {
  skillId?: string;
  locale?: string;
  /** 'auto' 或 ai_config.id；不传按 auto 处理 */
  modelId?: string;
}

function bySortOrder(a: AIProfile, b: AIProfile): number {
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  return a.id.localeCompare(b.id);
}

function clampTier(value: number | undefined): number {
  if (!Number.isFinite(value as number)) return 3;
  return Math.min(5, Math.max(1, Math.round(value as number)));
}

/** 数一下历史里已经有几次工具结果：深链路任务多半还要继续调工具，auto 该往高档走 */
function countToolMessages(history: Message[]): number {
  let count = 0;
  for (const message of history || []) {
    if ((message as any)?.role === 'tool') count++;
  }
  return count;
}

/** Agent 事件类型 */
export type AgentEventType =
  | 'thinking' | 'message' | 'tool_call' | 'tool_result' | 'audit_entry' | 'done' | 'error' | 'system_info'
  | 'model_selected';

/** Agent 事件（应用层简化格式） */
export interface AgentEvent {
  type: AgentEventType;
  content?: string;
  tool?: string;
  args?: any;
  result?: string;
  error?: string;
  auditEntry?: any;
  /** LLM token 消耗统计（done 事件携带） */
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
  /** 本轮实际使用的模型（auto 模式下由路由选出） */
  modelId?: string;
  modelLabel?: string;
  /** auto 路由的决策依据，让用户看得见「为什么用这个模型」 */
  route?: { target: string; tier: number; score: number; reasons: string[] };
  /** 错误码：前端按它本地化提示（如预算超限具体是哪一项） */
  code?: string;
}

export type AgentEventCallback = (event: AgentEvent) => void;

export type ToolExecutor = (args: any, sessionId: string) => Promise<string>;

// ========== 显示消息 & 历史 ==========

export interface DisplayMessage {
  role: 'user' | 'assistant';
  content: string;
  skillName?: string;
  isSystemInfo?: boolean;
  agentSteps?: DisplayAgentStep[];
}

export interface DisplayAgentStep {
  type: 'tool_call' | 'tool_result';
  tool?: string;
  args?: any;
  result?: string;
  collapsed?: boolean;
}

export interface HistoryMeta {
  sessionId: string;
  sessionName?: string;
  savedAt: number;
  messageCount: number;
  preview: string;
}

// ========== 服务依赖接口 ==========

interface ISSHService {
  writeData(sessionId: string, data: string | Buffer): boolean;
  captureOutput(sessionId: string, timeoutMs?: number): Promise<string>;
  captureOutputIdle(sessionId: string, idleMs?: number, maxMs?: number): Promise<string>;
  getOutputBuffer(sessionId: string, maxLines?: number): string;
  getSession(sessionId: string): any;
  getSystemContext(sessionId: string): Promise<string>;
}

interface ISkillService {
  getSkill(ownerId: string, id: string): Promise<{ name: string; content: string } | undefined>;
}

// ========== 工具与终端会话的绑定 ==========

/** agentRun 每轮通过 context.custom 带进来的「命令在哪个终端跑」的 key */
const TERMINAL_SESSION_KEY = 'terminalSessionId';

/**
 * 从工具上下文里取终端会话 ID。
 *
 * 这里绝不能退回 ctx.sessionId：engine 把它用作对话上下文的 key（= chatId，形如 chat_xxx），
 * 拿它去 sshService 的 sessions 里查必然落空，工具只能回一句 not found，
 * 而模型见到 not found 就对用户说「终端会话已断开」—— 方向完全指错了。
 * 自建对话以来 chatId 与终端会话就是两件事（见 agentRun 注释），工具要靠 custom 里的显式绑定。
 */
function terminalSessionOf(ctx: ToolContext): string {
  return (ctx.custom?.[TERMINAL_SESSION_KEY] as string) || '';
}

/** 这一轮压根没绑终端：让模型如实说「先打开终端」，而不是猜一个「断开」 */
const NO_TERMINAL_MSG = 'NO_TERMINAL: this chat is not bound to any terminal session, so no command can run. '
  + 'Ask the user to open a terminal (an SSH connection or the Local Shell) and retry. '
  + 'Do NOT say the terminal session was "disconnected" - there is none attached here. '
  + 'Do NOT call execute_command / read_terminal again this round.';

/** 传来的 id 在服务端查不到（没开过、或者已经关掉） */
function unknownTerminalMsg(sessionId: string): string {
  return `TERMINAL_NOT_FOUND: no terminal session is registered under "${sessionId}" `
    + '(it was never opened, or it has already been closed). '
    + 'Ask the user to open or reconnect a terminal, then stop calling tools. Never invent command output.';
}

// ========== Agent System Prompt ==========

const AGENT_SYSTEM_PROMPT = `You are a powerful AI terminal Agent that can directly operate the user's terminal Shell.

Your capabilities:
1. Execute commands directly in the terminal via the execute_command tool
2. Read the terminal's current output via the read_terminal tool
3. Understand command execution results and make decisions accordingly
4. Automatically complete multi-step tasks
5. Generate script files to execute complex or multi-step operations

Working principles:
1. **Take action**: When the user asks you to do something, use tools to execute directly, don't just suggest commands
2. **Verify results**: After executing a command, check the output to confirm success
3. **Safety first**: rm commands automatically move files to a recycle bin (~/.aetherops/.trash/) instead of permanent deletion; extremely destructive operations will be blocked. For other dangerous operations (format, overwrite disk, etc.), explain the risk in content first and let the user confirm before executing
4. **Step-by-step**: Complete complex tasks step by step, checking results after each step
5. **Error handling**: If a command fails, analyze the cause and try to fix it or use an alternative

Script strategy (important):
Generate a script file instead of executing commands one by one when the task meets any of the following conditions:
- More than 3 steps with dependencies between them
- Requires loops, conditionals, error handling, or other logic
- Needs to process large numbers of files or batch operations
- Needs to parse text/logs/JSON or other complex data

Script execution flow:
1. First detect available languages with \`which python3 node bash\` (Windows: \`where python node powershell\`)
2. Prefer languages already known from system environment info
3. Create and execute the script based on the platform:

**Linux/macOS (Bash):**
\`\`\`
cat > /tmp/_ai_task.sh << 'SCRIPT_EOF'
#!/bin/bash
set -e
# script content...
SCRIPT_EOF
chmod +x /tmp/_ai_task.sh && bash /tmp/_ai_task.sh
\`\`\`

**Windows (PowerShell):**
\`\`\`powershell
Set-Content -Path $env:TEMP\\_ai_task.ps1 -Value @'
# PowerShell script content...
'@
& $env:TEMP\\_ai_task.ps1
\`\`\`

4. Execute the script and check results
5. Clean up temporary files

Language selection priority:
- Shell/Bash (Linux/macOS): system admin, file ops, process management
- PowerShell (Windows): system admin, file ops, process management, WMI/CIM queries
- Python: log analysis, data processing, text parsing, complex logic (cross-platform)
- Node.js: JSON processing, HTTP requests, complex data transformation (cross-platform)

Cross-platform notes:
- Determine target platform from OS and Shell fields in system environment info
- Linux: OS=Linux, use bash commands
- macOS: OS=Darwin, no \`free\`/\`ss\`/\`systemctl\`, use \`vm_stat\`/\`lsof\`/\`launchctl\` instead
- Windows: Shell=PowerShell, use PowerShell cmdlets, temp files in \`$env:TEMP\`
- Always check platform first before selecting commands when writing scripts

Response format (important):
- Use Markdown format
- Before tool calls, just one sentence explaining what you're about to do, don't explain command details
- After task completion, give a brief conclusion of the results, don't repeat command output, don't list execution steps, don't add unnecessary explanations
- If the operation succeeds, state the result directly (e.g., "Created", "Stopped", "Found 3 errors")
- If the operation fails, explain the cause and suggested fix
- No fluff, no filler, no summarizing what's already obvious

**Language rule (CRITICAL)**: Always respond in the SAME language as the user's message. If the user writes in Chinese, respond in Chinese. If the user writes in English, respond in English. Match the user's language exactly.`;


// ============================================================
// AIService — 底层 AI 能力委托给 @cicctencent/agent-core
// ============================================================

export class AIService {
  // ---- 模型配置（按账号、按配置 ID 两级） ----
  // 不能再用一个 this.config：同进程里多个账号同时在用，谁最后保存谁覆盖所有人。
  // 一层 ownerId → 一层 profileId：一个账号可以有多套模型，auto 要在这几套之间挑。
  private profiles = new Map<string, Map<string, AIProfile>>();

  // ---- agent-core 组件（按 `ownerId:profileId`） ----
  // engine 绑定的是某套配置的 provider（模型 / Key / BaseURL），
  // 所以缓存粒度是配置而不是账号：切模型必须换 provider，不能复用。
  private providers = new Map<string, LLMProvider>();
  private engines = new Map<string, AgentEngine>();
  private toolRegistry: ToolRegistry;
  private contextManager: ContextManager;
  private securityGuard: SecurityGuard;
  /** key 是 `ownerId:chatId`：chatId 由前端传，不能假定跨账号唯一，
   *  否则拿到别人的 chatId 就能中止对方的 Agent。 */
  private abortControllers = new Map<string, AbortController>();

  // ---- 状态 ----
  private loadedSessions = new Set<string>();
  private sshService?: ISSHService;
  private skillService?: ISkillService;
  private auditService?: AuditService;
  private readonly MAX_MESSAGES = 50;
  private readonly MAX_AGENT_ITERATIONS = 15;

  constructor(sshService?: ISSHService, skillService?: ISkillService, auditService?: AuditService) {
    this.sshService = sshService;
    this.skillService = skillService;
    this.auditService = auditService;

    // 初始化 agent-core 组件
    this.toolRegistry = new ToolRegistry();
    this.contextManager = new ContextManager();
    this.securityGuard = new SecurityGuard({
      // 注意：这里不是本进程的文件路径，而是「改写后将在目标机上执行的命令」里的路径。
      // agent-core 的 delete-protection 把 rm X 改写成 mkdir -p <trashDir> && mv X <trashDir>/_del_<ts>，
      // 所以必须保留 `~/` 这种目标机相对形式：换成服务端绝对路径，
      // 远端主机会把文件移到远端不存在（或属于服务端）的目录，删除保护直接失效。
      trashDir: '~/.aetherops/.trash',
      deleteProtection: true,
    });
    // agent-core 0.1.4 已内置 Windows 黑名单（format C:, clear-disk, rd /s, Remove-Item drive root）
    // 无需再手动添加

    this.registerBuiltinTools();
  }

  /**
   * 配置改为按账号懒加载：启动时还不知道谁会登录，
   * 在这里读任何一条 ai_config 都只是猜。
   */
  async init(): Promise<void> {
    console.log('[AIService] 配置按账号懒加载（登录后首次使用时读取 ai_config）');
    // 预热定价目录：不等它，但让「第一次保存配置」就能用上真实单价
    prefetchCatalog();
  }

  // ========== 按账号配置（多套） ==========

  /**
   * 取某个账号的全部模型配置：没缓存就读库。
   *
   * 空库时返回空数组而不是「默认配置」：没有 Key 就不能对话，
   * 前端直接引导去设置页新增，比塞一个 apiKey 为空的假配置更清楚。
   * 读库失败直接抛：拿默认配置继续跑会让用户以为「Key 丢了」，实际是库连不上。
   */
  private async ensureProfiles(ownerId: string): Promise<AIProfile[]> {
    const cached = this.profiles.get(ownerId);
    if (cached) return [...cached.values()].sort(bySortOrder);

    const rows = await listAIConfigRows(ownerId);
    const map = new Map<string, AIProfile>();
    for (const row of rows) {
      map.set(row.id, {
        id: row.id,
        label: row.label || row.model || row.id,
        enabled: row.enabled,
        provider: row.provider || 'openai',
        apiKey: this.decryptSecretIfNeeded(row.apiKeyEnc),
        baseUrl: row.baseUrl || '',
        model: row.model || '',
        maxTokens: row.maxTokens ?? undefined,
        temperature: row.temperature ?? undefined,
        costTier: row.costTier,
        costTierSource: row.costTierSource,
        priceIn: row.priceIn,
        priceOut: row.priceOut,
        sortOrder: row.sortOrder,
      });
    }
    this.profiles.set(ownerId, map);
    return [...map.values()].sort(bySortOrder);
  }

  private async findProfile(ownerId: string, profileId?: string): Promise<AIProfile | undefined> {
    const list = await this.ensureProfiles(ownerId);
    if (!list.length) return undefined;
    if (!profileId) return list.find((p) => p.enabled && p.apiKey) || list[0];
    return list.find((p) => p.id === profileId);
  }

  // ========== LLM Provider & Engine 懒初始化 ==========

  private async ensureLLMProvider(ownerId: string, profile: AIProfile): Promise<LLMProvider | undefined> {
    if (!profile.apiKey) return undefined;

    const cacheKey = `${ownerId}:${profile.id}`;
    let provider = this.providers.get(cacheKey);
    if (!provider) {
      provider = createLLMProvider({
        provider: profile.provider || 'openai',
        model: profile.model,
        apiKey: profile.apiKey,
        baseUrl: profile.baseUrl,
        temperature: profile.temperature,
        maxTokens: profile.maxTokens,
      });
      this.providers.set(cacheKey, provider);
    }
    return provider;
  }

  /** 不传 profileId 清该账号全部：改配置后旧 provider 里的 Key/模型已经不对了 */
  private resetProviderAndEngine(ownerId: string, profileId?: string): void {
    const prefix = `${ownerId}:`;
    if (profileId) {
      this.providers.delete(`${ownerId}:${profileId}`);
      this.engines.delete(`${ownerId}:${profileId}`);
      return;
    }
    for (const key of [...this.providers.keys()]) if (key.startsWith(prefix)) this.providers.delete(key);
    for (const key of [...this.engines.keys()]) if (key.startsWith(prefix)) this.engines.delete(key);
  }

  private async getEngine(ownerId: string, profile: AIProfile, terminalSessionId: string): Promise<AgentEngine | undefined> {
    const provider = await this.ensureLLMProvider(ownerId, profile);
    if (!provider) return undefined;

    // 缓存 key 必须带终端会话：hooks 里的审计要记「命令在哪个终端里跑的」，
    // 这是构造时闭包进去的，同一套配置在不同终端之间不能共用同一个 engine。
    const cacheKey = `${ownerId}:${profile.id}:${terminalSessionId}`;
    let engine = this.engines.get(cacheKey);
    if (!engine) {
      engine = new AgentEngine({
        llmProvider: provider,
        toolRegistry: this.toolRegistry,
        contextManager: this.contextManager,
        securityGuard: this.securityGuard,
        basePrompt: AGENT_SYSTEM_PROMPT,
        maxIterations: this.MAX_AGENT_ITERATIONS,
        maxMessages: this.MAX_MESSAGES,
        hooks: this.buildHooks(ownerId, terminalSessionId),
      });
      this.engines.set(cacheKey, engine);
    }
    return engine;
  }

  /**
   * 审计钩子。
   * 
   * 注意 ctx.sessionId 现在是 chatId（engine 的上下文 key），
   * 而审计要记的是「命令在哪个终端里跑的」，所以终端会话 ID 用闭包带进来，
   * 不能再用 ctx.sessionId——否则审计日志里的 sessionId 会变成对话 ID，
   * 拿它去查终端归属永远查不到。
   */
  private buildHooks(ownerId: string, terminalSessionId?: string): import('@cicctencent/agent-core').Hook[] {
    if (!this.auditService) return [];
    const auditService = this.auditService;
    const sshService = this.sshService;
    const sessionId = terminalSessionId || '';
    return [{
      name: 'audit-tool-call',
      event: 'after_tool' as const,
      handler: async (ctx) => {
        try {
          const command = ctx.tool === 'execute_command'
            ? (ctx.args?.command as string || '')
            : JSON.stringify(ctx.args);
          // ownerId 从构造时闭包捕获：hooks 挂在某人的 engine 上，不会串号
          await auditService.log(ownerId, {
            sessionId,
            sessionName: sshService?.getSession(sessionId)?.name,
            connectionId: sshService?.getSession(sessionId)?.connectionId,
            userMessage: '',
            tool: ctx.tool || '',
            command,
            result: (ctx.result || '').substring(0, 5000),
            duration: ctx.duration || 0,
            status: ctx.isError ? 'error' : 'success',
          });
        } catch { /* 审计失败不影响主流程 */ }
      },
    }];
  }

  // ========== 模型配置管理 ==========

  /** 密文字段按需解密：数据库里存的永远是 enc:v1: 密文 */
  private decryptSecretIfNeeded(value: string): string {
    if (!value) return '';
    return value.startsWith(ENCRYPTED_PREFIX) ? this.decryptSecret(value) : value;
  }

  /**
   * 写一套配置到 MySQL。
   * 写失败必须抛出去：吞掉会让前端看到「已保存」而库里还是旧值，
   * 这是最难查的一类不一致。
   */
  private async persistProfile(ownerId: string, profile: AIProfile): Promise<void> {
    const encryptedKey = profile.apiKey && !profile.apiKey.startsWith(ENCRYPTED_PREFIX)
      ? this.encryptSecret(profile.apiKey)
      : profile.apiKey;
    await saveAIConfigRow(ownerId, {
      id: profile.id,
      label: profile.label || profile.model || profile.id,
      enabled: profile.enabled,
      provider: profile.provider,
      baseUrl: profile.baseUrl,
      model: profile.model,
      apiKeyEnc: encryptedKey || '',
      maxTokens: profile.maxTokens ?? null,
      temperature: profile.temperature ?? null,
      costTier: profile.costTier,
      costTierSource: profile.costTierSource || 'manual',
      priceIn: profile.priceIn ?? null,
      priceOut: profile.priceOut ?? null,
      sortOrder: profile.sortOrder,
    }, profile.id);
  }

  private getEncryptionKey(): Buffer {
    const keyPath = getDataPath('ai-config.key');
    try {
      if (fs.existsSync(keyPath)) {
        return crypto.createHash('sha256').update(fs.readFileSync(keyPath, 'utf8').trim()).digest();
      }
      const secret = crypto.randomBytes(32).toString('base64url');
      fs.writeFileSync(keyPath, secret, { encoding: 'utf8', mode: 0o600 });
      try { fs.chmodSync(keyPath, 0o600); } catch (_) { /* ignore */ }
      return crypto.createHash('sha256').update(secret).digest();
    } catch (error: any) {
      console.warn(`[AIService] Failed to load encryption key: ${error.message}`);
      return crypto.createHash('sha256').update(`${os.hostname()}:${os.homedir()}:aetherops-ai`).digest();
    }
  }

  private encryptSecret(value: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.getEncryptionKey(), iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${ENCRYPTED_PREFIX}${Buffer.concat([iv, tag, encrypted]).toString('base64')}`;
  }

  private decryptSecret(value: string): string {
    try {
      const payload = Buffer.from(value.slice(ENCRYPTED_PREFIX.length), 'base64');
      const iv = payload.subarray(0, 12);
      const tag = payload.subarray(12, 28);
      const encrypted = payload.subarray(28);
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.getEncryptionKey(), iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
    } catch (error: any) {
      console.warn(`[AIService] Failed to decrypt API key: ${error.message}`);
      return '';
    }
  }

  // ========== 公共配置 API（多套模型） ==========

  /**
   * 列出账号的全部模型配置。
   *
   * apiKey 不做掩码：配置已按账号隔离，读到的必然是调用者本人的 key，
   * 再打一遍码只会让用户没法核对、也没法把 key 复制出来用。
   * 需要遮眼时由前端输入框自己的眼睛开关负责，不影响这里原样下发。
   */
  async listProfiles(ownerId: string): Promise<AIProfile[]> {
    return (await this.ensureProfiles(ownerId)).map((p) => ({ ...p }));
  }

  /** 新增或更新一套配置；没有 id 视为新增，由服务端生成 */
  async saveProfile(ownerId: string, input: Partial<AIProfile>): Promise<AIProfile> {
    const list = await this.ensureProfiles(ownerId);
    const existing = input.id ? list.find((p) => p.id === input.id) : undefined;
    if (!existing && list.length >= MAX_PROFILES) {
      throw new Error(`最多只能配置 ${MAX_PROFILES} 个模型`);
    }
    const id = existing?.id || input.id || `p_${crypto.randomBytes(6).toString('hex')}`;

    // 档位归属：请求里带了 costTier 就视为用户手填（前端在「没动过下拉框」时不带这个字段）。
    // 否则沿用原来的来源，新增的默认 auto —— 让新配置一上手就有依据，
    // 而不是默默落成默认的 3 档。
    const costTierSource: 'auto' | 'manual' = input.costTier !== undefined
      ? 'manual'
      : (existing?.costTierSource === 'manual' ? 'manual' : 'auto');

    const profile: AIProfile = {
      id,
      label: (input.label ?? existing?.label ?? '').trim(),
      enabled: input.enabled ?? existing?.enabled ?? true,
      provider: input.provider ?? existing?.provider ?? 'openai',
      apiKey: input.apiKey ?? existing?.apiKey ?? '',
      baseUrl: input.baseUrl ?? existing?.baseUrl ?? '',
      model: input.model ?? existing?.model ?? '',
      maxTokens: input.maxTokens ?? existing?.maxTokens,
      temperature: input.temperature ?? existing?.temperature,
      costTier: clampTier(input.costTier ?? existing?.costTier),
      costTierSource,
      priceIn: existing?.priceIn ?? null,
      priceOut: existing?.priceOut ?? null,
      sortOrder: input.sortOrder ?? existing?.sortOrder ?? list.length,
    };
    if (!profile.model) throw new Error('模型名称不能为空');

    // 手填了档位也要刷新单价：换了模型却沿用旧模型的价格，金额会算错
    const modelChanged = !!existing && existing.model !== profile.model;
    if (costTierSource === 'auto' || modelChanged) {
      const decision = await this.resolveAutoTier(profile, list);
      if (decision) {
        profile.priceIn = decision.priceIn;
        profile.priceOut = decision.priceOut;
        if (costTierSource === 'auto') profile.costTier = decision.tier;
      }
    }

    await this.persistProfile(ownerId, profile);

    // 缓存与 engine 一起更新：不重置的话旧 Key / 旧模型会继续被复用
    const map = this.profiles.get(ownerId) || new Map<string, AIProfile>();
    map.set(id, profile);
    this.profiles.set(ownerId, map);
    this.resetProviderAndEngine(ownerId, id);
    return { ...profile };
  }

  /**
   * 自动定档。必须把「这条 + 账号下其它配置」一起交给分析器：
   * 档位是相对排位，只看自己一条算不出高低。
   * 不等待定价目录：保存是用户正在等的操作，目录没缓存就用模型名规则。
   */
  private async resolveAutoTier(
    profile: AIProfile,
    list: AIProfile[],
  ): Promise<{ tier: number; priceIn: number | null; priceOut: number | null } | null> {
    const drafts: CostTierInput[] = [...list.filter((p) => p.id !== profile.id), profile].map((p) => ({
      id: p.id,
      label: p.label,
      provider: p.provider,
      model: p.model,
      enabled: p.enabled,
      costTier: p.costTier,
      costTierSource: (p.costTierSource || 'auto') as 'auto' | 'manual',
      priceIn: p.priceIn ?? null,
      priceOut: p.priceOut ?? null,
    }));
    try {
      const analysis = await analyzeProfiles(drafts, { waitForCatalog: false });
      return analysis.decisions.find((d) => d.id === profile.id) || null;
    } catch (error: any) {
      console.warn(`[AIService] 档位分析失败（${error.message}），保留用户填的值`);
      return null;
    }
  }

  /**
   * 只体检、不写库：设置页打开时调用。
   * 与 reanalyzeCosts 的区别是不等定价目录、不落库 —— 打开弹窗不应该
   * 因为网络慢而卡住。
   */
  async checkupCosts(ownerId: string): Promise<CostAnalysisResult> {
    const list = await this.ensureProfiles(ownerId);
    const drafts: CostTierInput[] = list.map((p) => ({
      id: p.id,
      label: p.label,
      provider: p.provider,
      model: p.model,
      enabled: p.enabled,
      costTier: p.costTier,
      costTierSource: (p.costTierSource || 'auto') as 'auto' | 'manual',
      priceIn: p.priceIn ?? null,
      priceOut: p.priceOut ?? null,
    }));
    return analyzeProfiles(drafts, { waitForCatalog: false });
  }

  /**
   * 重算全账号档位与单价：把 auto 来源的全部刷新，manual 的只刷新价格。
   * 用户主动点「重新分析」时才等待定价目录，这时他就是想要一个准的结果。
   */
  async reanalyzeCosts(ownerId: string): Promise<CostAnalysisResult & { profiles: AIProfile[] }> {
    const list = await this.ensureProfiles(ownerId);
    const drafts: CostTierInput[] = list.map((p) => ({
      id: p.id,
      label: p.label,
      provider: p.provider,
      model: p.model,
      enabled: p.enabled,
      costTier: p.costTier,
      costTierSource: (p.costTierSource || 'auto') as 'auto' | 'manual',
      priceIn: p.priceIn ?? null,
      priceOut: p.priceOut ?? null,
    }));
    const analysis = await analyzeProfiles(drafts, { waitForCatalog: true });

    const updated: AIProfile[] = [];
    for (const profile of list) {
      const decision = analysis.decisions.find((d) => d.id === profile.id);
      if (!decision) continue;
      const isManual = profile.costTierSource === 'manual';
      const next: AIProfile = {
        ...profile,
        costTier: isManual ? profile.costTier : decision.tier,
        priceIn: decision.priceIn,
        priceOut: decision.priceOut,
      };
      // 手填档位又没价格变化时不必写库，少一次无意义的 UPDATE
      if (next.costTier === profile.costTier && next.priceIn === profile.priceIn && next.priceOut === profile.priceOut) {
        updated.push(next);
        continue;
      }
      await this.persistProfile(ownerId, next);
      updated.push(next);
    }
    const map = new Map<string, AIProfile>();
    for (const p of updated) map.set(p.id, p);
    this.profiles.set(ownerId, map);
    this.resetProviderAndEngine(ownerId);
    return { ...analysis, profiles: updated.map((p) => ({ ...p })) };
  }

  async deleteProfile(ownerId: string, id: string): Promise<void> {
    if (id === AUTO_MODEL_ID) throw new Error('auto 是内置的虚拟模型，不能删除');
    await deleteAIConfigRow(ownerId, id);
    this.profiles.get(ownerId)?.delete(id);
    this.resetProviderAndEngine(ownerId, id);
  }

  /** 测试一套配置：可以传还没保存的表单值，不传 id 就是纯试连 */
  async testProfile(ownerId: string, input?: Partial<AIProfile>): Promise<{ success: boolean; message: string }> {
    const base = input?.id ? (await this.ensureProfiles(ownerId)).find((p) => p.id === input.id) : undefined;
    const cfg = { ...(base || {}), ...input } as Partial<AIProfile>;
    if (!cfg.apiKey) return { success: false, message: 'API Key not configured' };
    try {
      const provider = createLLMProvider({
        provider: cfg.provider || 'openai',
        model: cfg.model || '',
        apiKey: cfg.apiKey,
        baseUrl: cfg.baseUrl || undefined,
      });
      const ok = await provider.ping();
      return ok
        ? { success: true, message: 'Connection successful, model available' }
        : { success: false, message: 'Connection failed or model unavailable' };
    } catch (error: any) {
      return { success: false, message: error.message || 'Connection failed' };
    }
  }

  // ---- 旧接口兼容：桌面端/VSCode 扩展的旧版本仍可能调 /api/ai/getConfig ----

  async getConfig(ownerId: string): Promise<AIConfig> {
    const profile = await this.findProfile(ownerId);
    if (!profile) throw new Error('No AI model configured');
    return { ...profile };
  }

  async getFullConfig(ownerId: string): Promise<AIConfig> {
    return this.getConfig(ownerId);
  }

  async updateConfig(ownerId: string, updates: Partial<AIConfig>): Promise<AIConfig> {
    const current = await this.findProfile(ownerId);
    await this.saveProfile(ownerId, { ...(current || {}), ...updates, id: current?.id || DEFAULT_AI_CONFIG_ID });
    return this.getConfig(ownerId);
  }

  async testConfig(ownerId: string, config?: Partial<AIConfig>): Promise<{ success: boolean; message: string }> {
    return this.testProfile(ownerId, config as Partial<AIProfile>);
  }

  // ========== 工具注册 ==========

  registerTool(name: string, definition: ToolDefinition, executor: ToolExecutor): void {
    this.toolRegistry.register({
      definition,
      // 终端会话从 context.custom 取：ctx.sessionId 是 chatId，拿它当会话 id 查不到任何终端
      executor: (args, ctx) => executor(args, terminalSessionOf(ctx)),
      category: 'custom',
    });
    console.log(`[AIService] Tool registered: ${name}`);
  }

  getToolDefinitions(): ToolDefinition[] {
    return this.toolRegistry.getDefinitions();
  }

  private registerBuiltinTools(): void {
    // execute_command
    this.toolRegistry.register({
      definition: {
        type: 'function',
        function: {
          name: 'execute_command',
          description: 'Execute a command in the current terminal Shell and return the output. Supports any bash/zsh/powershell commands.',
          parameters: {
            type: 'object',
            properties: {
              command: { type: 'string', description: 'The shell command to execute' },
              timeout: { type: 'number', description: 'Time to wait for output in milliseconds, default 2000. Increase for long-running commands' },
            },
            required: ['command'],
          },
        },
      },
      executor: async (args: Record<string, unknown>, ctx: ToolContext) => {
        // 会话在不在由 executeCommand 开头的 terminalGuard 统一判，两条工具路不用各写一份
        return this.executeCommand(args.command as string, terminalSessionOf(ctx), (args.timeout as number) || 2000);
      },
      category: 'builtin',
    });

    // read_terminal
    this.toolRegistry.register({
      definition: {
        type: 'function',
        function: {
          name: 'read_terminal',
          description: 'Read the current terminal output (last 50 lines), useful for understanding the terminal state.',
          parameters: { type: 'object', properties: {} },
        },
      },
      executor: async (_args: Record<string, unknown>, ctx: ToolContext) => {
        return this.readTerminal(terminalSessionOf(ctx));
      },
      category: 'builtin',
    });
  }

  // ========== 命令安全检查 ==========

  private async isWindowsSession(sessionId: string): Promise<boolean> {
    if (!this.sshService) return false;
    try {
      const ctx = await this.sshService.getSystemContext(sessionId);
      return /OS:.*Windows|Shell:.*PowerShell|Shell:.*pwsh/i.test(ctx);
    } catch { return false; }
  }

  private async sanitizeCommand(command: string, sessionId: string): Promise<{ safe: boolean; rewritten?: string; reason?: string }> {
    const trimmed = command.trim();
    const risk = assessDangerousCommand(trimmed);
    if (!risk.safe) return risk;
    const isWin = await this.isWindowsSession(sessionId);
    return isWin ? this.sanitizeWindowsCommand(trimmed) : { safe: true };
  }

  private sanitizeWindowsCommand(trimmed: string): { safe: boolean; rewritten?: string; reason?: string } {
    const blocked = [
      /format\s+[a-z]:/i, /clear-disk/i,
      /remove-item\s+.*[a-z]:\s*$/i, /remove-item\s+.*-recurse.*[a-z]:\s*$/i,
      /rd\s+\/s\s+[a-z]:\s*$/i,
    ];
    for (const pattern of blocked) {
      if (pattern.test(trimmed)) return { safe: false, reason: 'BLOCKED: Extremely dangerous destructive operation' };
    }
    const removePatterns = [/^(Remove-Item|ri|del|rd)\s+(.+)$/i];
    for (const pattern of removePatterns) {
      const match = trimmed.match(pattern);
      if (match) {
        const targets = match[2]
          .replace(/-Recurse/gi, '').replace(/-Force/gi, '').replace(/-Confirm:\$false/gi, '')
          .replace(/\/s/gi, '').replace(/\/q/gi, '').trim();
        // 同上：这是目标机 Windows 会话里执行的路径表达式，$env:USERPROFILE 由远端 PowerShell 展开，
        // 不能改成服务端的 getDataPath('.trash')。
        const trashDir = '$env:USERPROFILE\\.aetherops\\.trash';
        const ts = Date.now();
        return {
          safe: true,
          rewritten: `New-Item -ItemType Directory -Force -Path "${trashDir}" | Out-Null; Move-Item -Path ${targets} -Destination "${trashDir}\\_del_${ts}" -Force`,
        };
      }
    }
    return { safe: true };
  }

  // ========== 工具执行 ==========

  /**
   * 工具动手之前的终端检查。返回 null 表示可以继续。
   *
   * 只放在 executeCommand / readTerminal 这两个咽喉处：自有工具、agent-core 内置工具、
   * 注入给 engine 的 ctx.shell 三条路最终都走到这里，漏不到别处去。
   * 报的内容必须区分「这轮没绑终端」和「绑的那个已经没了」：
   * 一句 not found 会让模型对用户编出「终端会话已断开」，而真实原因常常是用户压根没开终端。
   */
  private terminalGuard(sessionId: string): string | null {
    if (!this.sshService) return 'Error: SSH service not available';
    if (!sessionId) return NO_TERMINAL_MSG;
    return this.sshService.getSession(sessionId) ? null : unknownTerminalMsg(sessionId);
  }

  private async executeCommand(command: string, sessionId: string, timeout: number): Promise<string> {
    const blocked = this.terminalGuard(sessionId);
    if (blocked) return blocked;
    // guard 已经确认过会话存在，这里的判空只是给 TS 看
    const session = this.sshService?.getSession(sessionId);
    if (!session) return unknownTerminalMsg(sessionId);

    const check = await this.sanitizeCommand(command, sessionId);
    if (!check.safe) return check.reason!;
    const actualCommand = check.rewritten || command;
    if (check.rewritten) console.log(`[AIService] Safety: rewrote "${command}" -> "${actualCommand}"`);

    try {
      // 采用「空闲即停」采集：不再用固定 2s 窗口硬等，输出稳定下来即返回（最长 10s 兜底），
      // 避免慢命令的输出被窗口截断、只拿到尾部。
      // 空闲即停采集；maxMs 取「用户 timeout 与 8s 下限」的较大值：
      // 既尊重工具传入的超时，又保证长命令有足够时间、短命令不空等。
      const outputPromise = this.sshService.captureOutputIdle(sessionId, 700, Math.max(timeout || 2000, 8000));
      // 必须用 '\r'（回车）结尾，而非 '\n'：伪终端的主设备侧需要 CR 才表示「按下回车」，
      // 服务内部所有探测命令（getSystemContext / probeCwdViaShell）都使用 '\r' 且能正常取到输出。
      this.sshService.writeData(sessionId, actualCommand + '\r');
      const output = await outputPromise;

      const lines = output.split('\n');
      if (lines.length > 0 && lines[0].trim().includes(actualCommand.trim().substring(0, 20))) lines.shift();
      const cleanOutput = lines.join('\n').trim();
      if (!cleanOutput) return '(Command executed, no output)';

      const maxLength = 5000;
      if (cleanOutput.length > maxLength) {
        return cleanOutput.substring(0, maxLength) + `\n... (output truncated, ${cleanOutput.length} chars total)`;
      }
      return cleanOutput;
    } catch (error: any) {
      return `Command execution failed: ${error.message}`;
    }
  }

  private async readTerminal(sessionId: string): Promise<string> {
    const blocked = this.terminalGuard(sessionId);
    if (blocked) return blocked;
    try {
      // 优先读取会话累积输出缓冲（当前屏幕内容），空闲终端也能拿到结果，
      // 不再依赖「调用后新到达」的采集窗口，避免一直捕不到输出。
      const buf = this.sshService.getOutputBuffer(sessionId, 200);
      if (buf && buf.trim()) return buf;
      // 兜底：缓冲为空时，尝试采集调用后新到达的输出（空闲即停，最长 3s）
      const output = await this.sshService.captureOutputIdle(sessionId, 500, 3000);
      if (!output.trim()) return '(No terminal output)';
      return output.split('\n').slice(-200).join('\n');
    } catch (error: any) {
      return `Failed to read terminal: ${error.message}`;
    }
  }

  /**
   * 构建注入到 agent-core ToolContext.shell 的执行器。
   * 新版 agent-core 内置的 execute_command / read_terminal 走 ctx.shell.exec/read，
   * 若不注入则落到 noop shell（不报错但捕不到任何输出）。这里接到本服务的 sshService，
   * 使无论引擎使用 AetherOps 自有工具还是 agent-core 内置工具，都能正确执行命令与读取终端。
   */
  private buildShellExecutor(sessionId: string) {
    return {
      exec: async (command: string, timeoutMs?: number) =>
        this.executeCommand(command, sessionId, timeoutMs || 2000),
      // 没绑终端时直接丢弃而不是空转：writeData 找不到会话本来也是静默返回，
      // 但那样模型会以为「已经敲下去了」，接着编造一段并不存在的输出
      write: (data: string) => {
        if (this.terminalGuard(sessionId)) return;
        this.sshService?.writeData(sessionId, data);
      },
      read: async (_lines?: number) => this.readTerminal(sessionId),
    };
  }

  // ========== 系统环境上下文 ==========

  private async getSessionContext(sessionId: string): Promise<string> {
    if (!this.sshService) return '';
    try { return await this.sshService.getSystemContext(sessionId); }
    catch (error) { console.warn('[AIService] Failed to get system context:', error); return ''; }
  }

  // ========== Core → App 事件映射 ==========

  private mapCoreEvent(event: CoreAgentEvent): AgentEvent | null {
    switch (event.type) {
      case 'thinking':    return { type: 'thinking', content: event.content };
      case 'tool_call':   return { type: 'tool_call', tool: event.tool, args: event.args };
      case 'tool_result': return { type: 'tool_result', tool: event.tool, result: event.result };
      case 'message':     return { type: 'message', content: event.content };
      case 'done':        return { type: 'done', content: event.content, usage: event.usage };
      case 'error':       return { type: 'error', error: event.error };
      default:            return null;
    }
  }

  // ========== Agent 核心循环 ==========

  /**
   * 跑一轮 Agent。
   *
   * chatId 与 terminalSessionId 是两件事，不能合并：
   * - chatId 是对话存储与 engine 上下文的 key（一个对话可以跨终端存在）；
   * - terminalSessionId 是命令真正要在哪个终端里执行。
   * 旧实现把两者当同一个用，所以对话无法脱离终端会话存在。
   */
  async agentRun(
    ownerId: string,
    chatId: string,
    terminalSessionId: string,
    userMessage: string,
    context: string | undefined,
    eventCallback: AgentEventCallback,
    opts?: AgentRunOptions,
  ): Promise<void> {
    const usable = (await this.ensureProfiles(ownerId)).filter((p) => p.enabled && p.apiKey);
    if (!usable.length) {
      eventCallback({ type: 'error', error: 'API Key not configured. Please set it in AI settings.' });
      return;
    }

    // 预算在「发起这一轮之前」检查：已经开始的对话不会中途被掐断。
    // 半途中断留下的是说到一半的方案，比多花一点 token 更难收拾。
    const budget = await this.checkBudget(ownerId, chatId);
    if (!budget.ok) {
      eventCallback({ type: 'error', error: budget.message, code: budget.code });
      return;
    }

    // 历史只读一次：auto 打分用的「已有工具调用数/历史长度」
    // 与随后注入 engine 的上下文必须是同一份快照。
    const savedHistory = (await this.loadChatMessages(ownerId, chatId)) || [];
    // 指定了具体模型时没有选择余地，不必去查实测统计
    const usingAuto = !opts?.modelId || opts.modelId === AUTO_MODEL_ID;
    const health = usingAuto ? await this.loadHealthForRouting(ownerId) : undefined;
    const { chain, decision } = this.buildModelChain(usable, opts?.modelId, {
      message: userMessage,
      context,
      priorToolCalls: countToolMessages(savedHistory),
      historyLength: savedHistory.length,
    }, health);
    if (!chain.length) {
      eventCallback({ type: 'error', error: 'API Key not configured. Please set it in AI settings.' });
      return;
    }

    // 构建 system prompt 覆盖片段
    let systemPromptOverride = '';

    if (opts?.locale) {
      const locale = opts.locale;
      const langName = locale.startsWith('zh') ? 'Chinese' : locale.startsWith('ja') ? 'Japanese' : locale.startsWith('ko') ? 'Korean' : 'English';
      systemPromptOverride += `\n\n[User's UI language preference: ${langName} (${locale}). If the user's message language is ambiguous, prefer responding in ${langName}.]`;
    }

    // 终端到不到得在开工前定下来：getSystemContext 拿不到 meta 时会回落成
    // 「服务端本机」的环境信息，拿着一个已经不存在的会话去问环境，
    // 等于把跑服务的那台机器当成用户的终端报给他。
    const terminalLive = !!terminalSessionId && !!this.sshService?.getSession(terminalSessionId);
    if (!terminalLive) {
      console.warn(`[AIService] 本轮没有可用的终端会话（terminal=${terminalSessionId || 'none'}），工具将直接返回 NO_TERMINAL`);
    }

    const sysContext = terminalLive ? await this.getSessionContext(terminalSessionId) : '';
    if (sysContext && sysContext !== 'Failed to collect system info') {
      systemPromptOverride += `\n\n${sysContext}`;
    }

    // 不先把话说在前面，模型会照着「你是终端 Agent」的设定反复调工具，
    // 连吃几次 not found 之后就对用户编出「终端会话已断开」。
    if (!terminalLive) {
      systemPromptOverride += '\n\n[No live terminal session is attached to this chat right now. '
        + 'execute_command / read_terminal will not work. '
        + 'Answer from the information you already have, and tell the user to open a terminal '
        + '(an SSH connection or the Local Shell) if the task really needs commands.]';
    }

    if (opts?.skillId && this.skillService) {
      const skill = await this.skillService.getSkill(ownerId, opts.skillId);
      if (skill) {
        systemPromptOverride += `\n\n## Current Task Instructions (Skill: ${skill.name})\n\n${skill.content}`;
      }
    }

    const ctrl = new AbortController();
    this.abortControllers.set(this.abortKey(ownerId, chatId), ctrl);

    let lastError = '';
    try {
      for (let attempt = 0; attempt < chain.length; attempt++) {
        const profile = chain[attempt];
        const engine = await this.getEngine(ownerId, profile, terminalSessionId);
        if (!engine) {
          lastError = `provider unavailable: ${profile.id}`;
          continue;
        }

        const modelLabel = profile.label || profile.model || profile.id;
        const route = decision
          ? { target: profile.id, tier: decision.tier, score: decision.score, reasons: decision.reasons }
          : undefined;

        // 先告诉前端这轮用哪个模型：用户能立刻看到「谁在回答」，
        // 降级时也能看到模型换了，而不是莫名其妙地换了口径。
        eventCallback({ type: 'model_selected', modelId: profile.id, modelLabel, route });
        if (attempt > 0) {
          console.warn(`[AIService] 降级重试 -> ${modelLabel}(${profile.id})，上一轮失败：${lastError}`);
        }

        engine.setHistory(chatId, savedHistory);
        let produced = false;
        try {
          // 注入 shell 执行器：新版 agent-core 的内置 execute_command/read_terminal 走
          // ctx.shell.exec/read，不注入则落到 noop shell（捕不到任何输出）。
          // terminalSessionId 必须一起放进 custom：ctx.sessionId 是对话 key，不是终端会话。
          const shellExecutor = this.buildShellExecutor(terminalSessionId);
          const runCustom = { shell: shellExecutor, [TERMINAL_SESSION_KEY]: terminalSessionId };
          const eventStream = engine.run({
            sessionId: chatId,
            message: userMessage,
            context: context
              ? { sessionId: chatId, terminalOutput: context, custom: runCustom }
              : { sessionId: chatId, custom: runCustom },
            abortSignal: ctrl.signal,
            systemPromptOverride: systemPromptOverride || undefined,
            skillId: opts?.skillId,
          });

          for await (const coreEvent of eventStream) {
            const mapped = this.mapCoreEvent(coreEvent);
            if (!mapped) continue;
            if (mapped.type === 'message' || mapped.type === 'tool_call') produced = true;
            if (mapped.type === 'error') {
              // 中间档的失败不单独下发：后面可能降级成功，
              // 否则前端会先弹一个报错又接着正常输出。
              lastError = mapped.error || 'Agent runtime error';
              continue;
            }
            if (mapped.type === 'done') {
              mapped.modelId = profile.id;
              mapped.modelLabel = modelLabel;
              mapped.route = route;
              void this.recordUsage(ownerId, profile, chatId, terminalSessionId, mapped.usage, true, !!decision);
            }
            eventCallback(mapped);
          }
        } catch (error: any) {
          lastError = error.message || 'Agent runtime error';
          // 失败也留一条（tokens 为 0）：没有失败记录就无法按实测成功率做路由自适应
          void this.recordUsage(ownerId, profile, chatId, terminalSessionId, undefined, false, !!decision);
        }

        // 每轮结束都存上下文：降级重试时下一档能接着用刚才的历史
        try {
          const snapshot = engine.getHistorySnapshot(chatId);
          if (snapshot && snapshot.length > 0) await this.saveChatMessages(ownerId, chatId, snapshot);
        } catch { /* ignore */ }

        // 已经产生输出就不换模型重试：重跑会让用户看到两套答案
        if (produced) return;
        if (ctrl.signal.aborted) return;
      }

      eventCallback({ type: 'error', error: lastError || 'All models are unavailable, please check AI settings.' });
    } finally {
      this.abortControllers.delete(this.abortKey(ownerId, chatId));
    }
  }

  /**
   * 选模型链：显式指定就只用它；auto（或指定了不可用模型）就按复杂度排序，
   * 后面的位置是降级候选。
   */
  private buildModelChain(
    usable: AIProfile[],
    requested: string | undefined,
    input: AutoRouteInput,
    health?: Map<string, ModelHealthStat>,
  ): { chain: AIProfile[]; decision?: AutoRouteDecision } {
    if (requested && requested !== AUTO_MODEL_ID) {
      const picked = usable.find((p) => p.id === requested);
      // 指定了已禁用/已删除的模型：退回 auto，总比直接报错强
      if (picked) return { chain: [picked] };
      console.warn(`[AIService] 指定的模型不可用（${requested}），回退到 auto`);
    }

    const decision = scoreTaskComplexity(input);
    const chain = rankProfilesForTier(usable, decision.tier, health).slice(0, MAX_AUTO_ATTEMPTS);
    console.log(`[AIService] auto 选型 ${describeAutoRoute(decision, chain[0])}`);
    return { chain, decision };
  }

  /**
   * 路由自适应的输入：近 7 天的成功率。
   * 查不到就当没有 —— 没统计历史不该让对话报错。
   */
  private async loadHealthForRouting(ownerId: string): Promise<Map<string, ModelHealthStat> | undefined> {
    try {
      const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const rows = await loadModelHealth(ownerId, since);
      return new Map(rows.map((row) => [row.modelId, { calls: row.calls, okCalls: row.okCalls }]));
    } catch (error: any) {
      console.warn(`[AIService] 模型健康度读取失败（${error.message}），本轮按档位排序`);
      return undefined;
    }
  }

  private abortKey(ownerId: string, chatId: string): string {
    return `${ownerId}:${chatId}`;
  }

  // ========== 成本与预算 ==========

  /**
   * 发起一轮前的预算检查。
   * 返回 code 而不是拼好的多语言文案：前端要能按自己的语言提示。
   */
  private async checkBudget(
    ownerId: string,
    chatId: string,
  ): Promise<{ ok: boolean; message?: string; code?: string }> {
    let budget: AIBudgetRow;
    try {
      budget = await loadBudgetRow(ownerId);
    } catch (error: any) {
      // 读不到预算就不拦：预算表出问题不该让整个 AI 功能停摆
      console.warn(`[AIService] 预算读取失败（${error.message}），本轮不限额`);
      return { ok: true };
    }
    if (!budget.chatTokenLimit && !budget.dailyTokenLimit && !budget.dailyCostLimit) return { ok: true };

    if (budget.chatTokenLimit) {
      const used = await sumUsage(ownerId, { chatId });
      if (used.totalTokens >= budget.chatTokenLimit) {
        return {
          ok: false,
          code: 'chat-token-limit',
          message: `Chat token limit reached (${used.totalTokens}/${budget.chatTokenLimit}). Start a new chat or raise the budget.`,
        };
      }
    }
    if (budget.dailyTokenLimit || budget.dailyCostLimit) {
      const today = await sumUsage(ownerId, { since: startOfToday() });
      if (budget.dailyTokenLimit && today.totalTokens >= budget.dailyTokenLimit) {
        return {
          ok: false,
          code: 'daily-token-limit',
          message: `Daily token limit reached (${today.totalTokens}/${budget.dailyTokenLimit}).`,
        };
      }
      if (budget.dailyCostLimit && today.costUsd >= budget.dailyCostLimit) {
        return {
          ok: false,
          code: 'daily-cost-limit',
          message: `Daily cost limit reached ($${today.costUsd.toFixed(4)}/$${budget.dailyCostLimit}).`,
        };
      }
    }
    return { ok: true };
  }

  /**
   * 取一份带单价的配置视图。
   * 保存时若定价目录还没加载完，落库的 price 是 null；直接拿它算金额会把
   * 这一轮记成 0 美元，面板上的花费与「省了多少」都会失真。所以现查一次
   * 目录兑底——目录已在进程内存里，不产生网络请求。
   */
  private pricedProfile(profile: AIProfile): AIProfile {
    if (profile.priceIn != null && profile.priceOut != null) return profile;
    const live = lookupPrice(profile.provider, profile.model);
    if (!live) return profile;
    return { ...profile, priceIn: live.inputPerM, priceOut: live.outputPerM };
  }

  /**
   * 记一笔用量。任何异常都吞掉：记账失败不该让对话本身失败。
   * 成功的调用若没拿到 usage 就不记 —— 0 token 的记录会拉低均值。
   */
  private async recordUsage(
    ownerId: string,
    profile: AIProfile,
    chatId: string,
    terminalSessionId: string,
    usage: AgentEvent['usage'],
    ok: boolean,
    autoRouted: boolean,
  ): Promise<void> {
    try {
      const promptTokens = usage?.promptTokens || 0;
      const completionTokens = usage?.completionTokens || 0;
      const totalTokens = usage?.totalTokens || promptTokens + completionTokens;
      if (ok && !totalTokens) return;
      const connectionId = this.sshService?.getSession(terminalSessionId)?.connectionId || '';
      await insertUsageRow(ownerId, {
        chatId,
        connectionId,
        modelId: profile.id,
        modelLabel: profile.label || profile.model || profile.id,
        autoRouted,
        promptTokens,
        completionTokens,
        totalTokens,
        costUsd: estimateCostUsd({ promptTokens, completionTokens }, this.pricedProfile(profile)),
        ok,
      });
    } catch (error: any) {
      console.warn(`[AIService] 用量写入失败：${error.message}`);
    }
  }

  async getBudget(ownerId: string): Promise<AIBudgetRow> {
    return loadBudgetRow(ownerId);
  }

  async updateBudget(ownerId: string, patch: Partial<AIBudgetRow>): Promise<AIBudgetRow> {
    const saved = await saveBudgetRow(ownerId, patch);
    return saved;
  }

  /** 成本洞察：今天是花得多了还是少了、钱都花在哪个模型上、auto 到底省了多少 */
  async getCostInsights(ownerId: string, opts?: { chatId?: string }): Promise<{
    today: UsageTotals;
    chat: UsageTotals | null;
    byModel: Array<{ modelId: string; modelLabel: string; calls: number; totalTokens: number; costUsd: number }>;
    budget: AIBudgetRow;
    baselineModel: { id: string; label: string; priceIn: number; priceOut: number } | null;
    savedUsd: number | null;
    partial: boolean;
  }> {
    const todayStart = startOfToday();
    const [today, chat, byModel, budget, profiles] = await Promise.all([
      sumUsage(ownerId, { since: todayStart }),
      opts?.chatId ? sumUsage(ownerId, { chatId: opts.chatId }) : Promise.resolve(null),
      groupUsageByModel(ownerId, todayStart),
      loadBudgetRow(ownerId),
      this.ensureProfiles(ownerId),
    ]);

    // 参照基准：手头上最贵的那个模型。auto 省的金额 =
    // 「同样这些 token 全用最贵的模型要花多少」- 「实际花了多少」。
    const priced = profiles
      .map((p) => this.pricedProfile(p))
      .filter((p) => p.priceIn != null && p.priceOut != null)
      .sort((a, b) => (b.priceIn! + b.priceOut!) - (a.priceIn! + a.priceOut!));
    const baseline = priced[0] || null;
    let savedUsd: number | null = null;
    if (baseline && today.calls > 0) {
      const hypothetical = (today.promptTokens * baseline.priceIn! + today.completionTokens * baseline.priceOut!) / 1e6;
      // 保留 6 位：浮点尾巴会跟着算出来的金额一路传到界面上
      savedUsd = Math.round(Math.max(0, hypothetical - today.costUsd) * 1e6) / 1e6;
    }

    return {
      today,
      chat,
      byModel,
      budget,
      baselineModel: baseline
        ? { id: baseline.id, label: baseline.label || baseline.model, priceIn: baseline.priceIn!, priceOut: baseline.priceOut! }
        : null,
      savedUsd,
      // 有调用查不到单价时金额被低估，界面要说明「部分金额未知」
      partial: today.unknownCostCalls > 0,
    };
  }

  stopAgent(ownerId: string, chatId: string): boolean {
    const ctrl = this.abortControllers.get(this.abortKey(ownerId, chatId));
    if (!ctrl) return false;
    ctrl.abort();
    // engine 的缓存 key 带模型和终端会话，这里按「以 chatId 结尾」找回来
    const prefix = `${ownerId}:`;
    for (const [key, engine] of this.engines) {
      if (key.startsWith(prefix) && key.endsWith(`:${chatId}`)) engine.abort(chatId);
    }
    return true;
  }

  // ========== 非 Agent 对话 ==========

  /** 不带工具的一次性问答：默认用当前最便宜的可用模型 */
  private async resolveProfile(ownerId: string, modelId?: string): Promise<AIProfile | undefined> {
    const usable = (await this.ensureProfiles(ownerId)).filter((p) => p.enabled && p.apiKey);
    if (!usable.length) return undefined;
    if (modelId && modelId !== AUTO_MODEL_ID) {
      const picked = usable.find((p) => p.id === modelId);
      if (picked) return picked;
    }
    return rankProfilesForTier(usable, 1)[0] || usable[0];
  }

  async chat(ownerId: string, chatId: string, userMessage: string, context?: string, modelId?: string): Promise<string> {
    const profile = await this.resolveProfile(ownerId, modelId);
    if (!profile) throw new Error('API Key not configured. Please set it in AI settings.');
    const provider = await this.ensureLLMProvider(ownerId, profile);
    if (!provider) throw new Error('API Key not configured. Please set it in AI settings.');

    const history = (await this.loadChatMessages(ownerId, chatId)) || [];
    const messages: Message[] = [{ role: 'system', content: AGENT_SYSTEM_PROMPT }];
    if (context) messages.push({ role: 'system', content: `Recent terminal output:\n\`\`\`\n${context}\n\`\`\`` });
    messages.push(...history);
    messages.push({ role: 'user', content: userMessage });
    history.push({ role: 'user', content: userMessage });

    try {
      const response = await provider.chat({
        messages,
        maxTokens: profile.maxTokens,
        temperature: profile.temperature,
      });
      const content = response.choices?.[0]?.message?.content;
      if (content) {
        const textContent = extractTextFromContent(content);
        history.push({ role: 'assistant', content: textContent });
        await this.saveChatMessages(ownerId, chatId, history);
        return textContent;
      }
      throw new Error('AI response is empty');
    } catch (error: any) {
      history.pop();
      throw new Error(error.response?.data?.error?.message || error.message || 'AI request failed');
    }
  }

  async *chatStream(
    ownerId: string,
    chatId: string,
    userMessage: string,
    context?: string,
    modelId?: string,
  ): AsyncGenerator<string, void, unknown> {
    const profile = await this.resolveProfile(ownerId, modelId);
    if (!profile) throw new Error('API Key not configured. Please set it in AI settings.');
    const provider = await this.ensureLLMProvider(ownerId, profile);
    if (!provider) throw new Error('API Key not configured. Please set it in AI settings.');

    const history = (await this.loadChatMessages(ownerId, chatId)) || [];
    const messages: Message[] = [{ role: 'system', content: AGENT_SYSTEM_PROMPT }];
    if (context) messages.push({ role: 'system', content: `Recent terminal output:\n\`\`\`\n${context}\n\`\`\`` });
    messages.push(...history);
    messages.push({ role: 'user', content: userMessage });
    history.push({ role: 'user', content: userMessage });

    let fullResponse = '';
    try {
      const stream = provider.chatStream({
        messages,
        maxTokens: profile.maxTokens,
        temperature: profile.temperature,
      });
      for await (const chunk of stream) {
        const content = chunk.delta?.content;
        if (content) {
          const textContent = extractTextFromContent(content);
          fullResponse += textContent;
          yield textContent;
        }
      }
      if (fullResponse) {
        history.push({ role: 'assistant', content: fullResponse });
        await this.saveChatMessages(ownerId, chatId, history);
      }
    } catch (error: any) {
      history.pop();
      throw new Error(error.response?.data?.error?.message || error.message || 'AI request failed');
    }
  }

  // ========== LLM 上下文消息持久化 ==========

  async clearHistory(ownerId: string, sessionId: string): Promise<void> {
    this.loadedSessions.delete(sessionId);
    await Promise.all([
      deleteHistory(ownerId, sessionId),
      deleteChatMessagesRow(ownerId, sessionId),
    ]);
    // engine 按「owner:model:terminal」分桶存放，同一对话可能命中多个桶，全扫一遍比记 key 可靠
    const prefix = `${ownerId}:`;
    for (const [key, engine] of this.engines) {
      if (key.startsWith(prefix) && key.endsWith(`:${sessionId}`)) engine.setHistory(sessionId, []);
    }
  }

  async getHistory(ownerId: string, sessionId: string): Promise<Message[] | null> {
    return this.loadChatMessages(ownerId, sessionId);
  }

  private async saveChatMessages(ownerId: string, sessionId: string, messages: Message[]): Promise<void> {
    try {
      await saveChatMessagesRow(ownerId, sessionId, messages.slice(-this.MAX_MESSAGES));
    } catch (error: any) {
      // 上下文写失败不该让对话本身失败，但必须留痕：否则下一轮会“失忆”而无从查起
      console.error('[AIService] Failed to save chat messages:', error.message);
    }
  }

  private async loadChatMessages(ownerId: string, sessionId: string): Promise<Message[] | null> {
    try {
      const messages = await loadChatMessagesRow(ownerId, sessionId);
      if (!messages || messages.length === 0) return null;
      return messages.slice(-this.MAX_MESSAGES) as Message[];
    } catch (error: any) {
      console.error('[AIService] Failed to load chat messages:', error.message);
      return null;
    }
  }

  // ========== 对话窗口（与连接绑定） ==========

  private toChatMeta(row: AIChatRow): AIChatMeta {
    return {
      id: row.id,
      connectionId: row.connectionId,
      title: row.title,
      modelId: row.modelId,
      messageCount: row.messageCount,
      preview: row.preview,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  async listChats(ownerId: string, connectionId?: string): Promise<AIChatMeta[]> {
    const rows = await listChatRows(ownerId, connectionId);
    const metas = rows.map((row) => this.toChatMeta(row));
    // 一次聚合查回全部对话的用量，避免列表页对每条对话各发一次查询
    try {
      const usage = await groupUsageByChat(ownerId, metas.map((m) => m.id));
      for (const meta of metas) {
        const found = usage.get(meta.id);
        meta.totalTokens = found?.totalTokens || 0;
        meta.costUsd = found?.costUsd || 0;
      }
    } catch (error: any) {
      // 用量查不到不影响列表本身
      console.warn(`[AIService] 对话用量汇总失败：${error.message}`);
    }
    return metas;
  }

  async getChat(ownerId: string, chatId: string): Promise<AIChatMeta | null> {
    const row = await loadChatRow(ownerId, chatId);
    return row ? this.toChatMeta(row) : null;
  }

  async createChat(ownerId: string, input?: { connectionId?: string; title?: string; modelId?: string }): Promise<AIChatMeta> {
    const id = `chat_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
    await insertChatRow(ownerId, {
      id,
      connectionId: input?.connectionId || '',
      title: (input?.title || '').trim(),
      modelId: input?.modelId || AUTO_MODEL_ID,
    });
    const row = await loadChatRow(ownerId, id);
    if (!row) throw new Error('创建对话失败');
    return this.toChatMeta(row);
  }

  async updateChat(ownerId: string, chatId: string, patch: { title?: string; modelId?: string }): Promise<AIChatMeta> {
    await updateChatRow(ownerId, chatId, patch);
    const row = await loadChatRow(ownerId, chatId);
    if (!row) throw new Error('对话不存在');
    return this.toChatMeta(row);
  }

  /** 删对话要连带消息体：否则 ai_history / ai_messages 会留下永远读不到的孤儿行 */
  async deleteChat(ownerId: string, chatId: string): Promise<void> {
    await deleteChatRow(ownerId, chatId);
    await this.clearHistory(ownerId, chatId);
    // 用量也一并清掉：否则今日/单对话预算里会永久挂着一笔查不到来源的账
    await deleteUsageByChat(ownerId, chatId).catch(() => undefined);
  }

  // ========== 对话历史持久化（前端显示） ==========

  async saveDisplayHistory(ownerId: string, chatId: string, displayMessages: DisplayMessage[], sessionName?: string): Promise<void> {
    try {
      const firstUser = displayMessages.find(m => m.role === 'user');
      await saveHistory({
        ownerId,
        sessionId: chatId,
        sessionName,
        messageCount: displayMessages.length,
        preview: (firstUser?.content || '').substring(0, 80),
        messages: displayMessages,
        savedAt: Date.now(),
      });

      // 列表页只读 ai_chats，摘要/条数必须同步过去；
      // 标题还空着就取首条用户消息（跟聊天软件的习惯一致，用户可随时改名）
      const row = await loadChatRow(ownerId, chatId);
      if (row) {
        await updateChatRow(ownerId, chatId, {
          messageCount: displayMessages.length,
          preview: (firstUser?.content || '').substring(0, 80),
          title: row.title || (firstUser?.content || '').substring(0, 40),
        });
      }
    } catch (error) { console.error('[AIService] Failed to save display history:', error); }
  }

  async loadDisplayHistory(ownerId: string, sessionId: string): Promise<DisplayMessage[] | null> {
    try {
      return (await loadHistoryMessages(ownerId, sessionId)) as DisplayMessage[] | null;
    } catch (error) {
      console.error('[AIService] Failed to load display history:', error);
      return null;
    }
  }

  async listDisplayHistories(ownerId: string): Promise<HistoryMeta[]> {
    try {
      return await listHistories(ownerId);
    } catch (error) {
      console.error('[AIService] Failed to list histories:', error);
      return [];
    }
  }

  async deleteDisplayHistoryFile(ownerId: string, sessionId: string): Promise<void> {
    try {
      await deleteHistory(ownerId, sessionId);
      await deleteChatMessagesRow(ownerId, sessionId);
      this.loadedSessions.delete(sessionId);
    } catch (error) { console.error('[AIService] Failed to delete display history:', error); }
  }
}
