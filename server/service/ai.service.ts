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
import { loadAIConfigRow, saveAIConfigRow, DEFAULT_AI_CONFIG_ID } from '../db/repositories/ai-config.repo';
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

/** Agent 事件类型 */
export type AgentEventType = 'thinking' | 'message' | 'tool_call' | 'tool_result' | 'audit_entry' | 'done' | 'error' | 'system_info';

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
  // ---- 配置（按账号） ----
  // 不能再用一个 this.config：同进程里多个账号同时在用，谁最后保存谁覆盖所有人。
  // 除 abortControllers 外，所有状态都以 ownerId 为 key。
  private configs = new Map<string, AIConfig>();

  // ---- agent-core 组件（按账号） ----
  // engine 绑定的是某个账号的 provider（模型 / Key / BaseURL），所以也必须一人一个
  private providers = new Map<string, LLMProvider>();
  private engines = new Map<string, AgentEngine>();
  private toolRegistry: ToolRegistry;
  private contextManager: ContextManager;
  private securityGuard: SecurityGuard;
  /** key 是 `ownerId:sessionId`：sessionId 由前端传，不能假定跨账号唯一，
   *  否则拿到别人的 sessionId 就能中止对方的 Agent。 */
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
  }

  // ========== 按账号配置 ==========

  /**
   * 取某个账号的配置：没缓存就读库，库里没记录就用默认值。
   * 读库失败直接抛：拿默认配置继续跑会让用户以为「Key 丢了」，实际是库连不上。
   */
  private async ensureConfig(ownerId: string): Promise<AIConfig> {
    const cached = this.configs.get(ownerId);
    if (cached) return cached;

    let config = this.getDefaultConfig();
    const row = await loadAIConfigRow(ownerId);
    if (row) {
      config = {
        ...config,
        enabled: row.enabled,
        provider: row.provider || config.provider,
        apiKey: this.decryptSecretIfNeeded(row.apiKeyEnc),
        baseUrl: row.baseUrl || config.baseUrl,
        model: row.model || config.model,
        maxTokens: row.maxTokens ?? config.maxTokens,
        temperature: row.temperature ?? config.temperature,
      };
    }
    this.configs.set(ownerId, config);
    return config;
  }

  // ========== LLM Provider & Engine 懒初始化 ==========

  private async ensureLLMProvider(ownerId: string): Promise<LLMProvider | undefined> {
    const config = await this.ensureConfig(ownerId);
    if (!config.apiKey) return undefined;

    let provider = this.providers.get(ownerId);
    if (!provider) {
      provider = createLLMProvider({
        provider: config.provider || 'openai',
        model: config.model,
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        temperature: config.temperature,
        maxTokens: config.maxTokens,
      });
      this.providers.set(ownerId, provider);
    }
    return provider;
  }

  private resetProviderAndEngine(ownerId: string): void {
    this.providers.delete(ownerId);
    this.engines.delete(ownerId);
  }

  private async getEngine(ownerId: string): Promise<AgentEngine | undefined> {
    const provider = await this.ensureLLMProvider(ownerId);
    if (!provider) return undefined;

    let engine = this.engines.get(ownerId);
    if (!engine) {
      engine = new AgentEngine({
        llmProvider: provider,
        toolRegistry: this.toolRegistry,
        contextManager: this.contextManager,
        securityGuard: this.securityGuard,
        basePrompt: AGENT_SYSTEM_PROMPT,
        maxIterations: this.MAX_AGENT_ITERATIONS,
        maxMessages: this.MAX_MESSAGES,
        hooks: this.buildHooks(ownerId),
      });
      this.engines.set(ownerId, engine);
    }
    return engine;
  }

  private buildHooks(ownerId: string): import('@cicctencent/agent-core').Hook[] {
    if (!this.auditService) return [];
    const auditService = this.auditService;
    const sshService = this.sshService;
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
            sessionId: ctx.sessionId,
            sessionName: sshService?.getSession(ctx.sessionId)?.name,
            connectionId: sshService?.getSession(ctx.sessionId)?.connectionId,
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

  // ========== 配置管理 ==========

  private getDefaultConfig(): AIConfig {
    return {
      enabled: true, provider: 'openai', apiKey: '',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini', maxTokens: 4000, temperature: 0.3,
    };
  }

  /** 密文字段按需解密：数据库里存的永远是 enc:v1: 密文 */
  private decryptSecretIfNeeded(value: string): string {
    if (!value) return '';
    return value.startsWith(ENCRYPTED_PREFIX) ? this.decryptSecret(value) : value;
  }

  /**
   * 写配置到 MySQL。
   * 写失败必须抛出去：吞掉会让前端看到「已保存」而库里还是旧值，
   * 这是最难查的一类不一致。
   */
  private async saveConfig(ownerId: string): Promise<void> {
    const config = await this.ensureConfig(ownerId);
    const encryptedKey = config.apiKey && !config.apiKey.startsWith(ENCRYPTED_PREFIX)
      ? this.encryptSecret(config.apiKey)
      : config.apiKey;
    await saveAIConfigRow(ownerId, {
      id: DEFAULT_AI_CONFIG_ID,
      label: '默认',
      enabled: config.enabled,
      provider: config.provider,
      baseUrl: config.baseUrl,
      model: config.model,
      apiKeyEnc: encryptedKey || '',
      maxTokens: config.maxTokens ?? null,
      temperature: config.temperature ?? null,
    });
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

  // ========== 公共配置 API ==========

  /**
   * 读取账号自己的 AI 配置。
   *
   * apiKey 不做掩码：配置已按账号隔离，读到的必然是调用者本人的 key，
   * 再打一遍码只会让用户没法核对、也没法把 key 复制出来用。
   * 需要遮眼时由前端输入框自己的眼睛开关负责，不影响这里原样下发。
   */
  async getConfig(ownerId: string): Promise<AIConfig> {
    return { ...await this.ensureConfig(ownerId) };
  }

  async getFullConfig(ownerId: string): Promise<AIConfig> {
    return this.getConfig(ownerId);
  }

  async updateConfig(ownerId: string, updates: Partial<AIConfig>): Promise<AIConfig> {
    // 入参就是完整配置：读取时不再下发掩码值，前端也就不可能把 **** 回传覆盖掉真实 key
    this.configs.set(ownerId, { ...await this.ensureConfig(ownerId), ...updates });
    await this.saveConfig(ownerId);
    this.resetProviderAndEngine(ownerId);
    return this.getConfig(ownerId);
  }

  async testConfig(ownerId: string, config?: Partial<AIConfig>): Promise<{ success: boolean; message: string }> {
    const testCfg = { ...await this.ensureConfig(ownerId), ...config };
    if (!testCfg.apiKey) return { success: false, message: 'API Key not configured' };
    try {
      const provider = createLLMProvider({
        provider: testCfg.provider || 'openai', model: testCfg.model,
        apiKey: testCfg.apiKey, baseUrl: testCfg.baseUrl,
      });
      const ok = await provider.ping();
      return ok
        ? { success: true, message: 'Connection successful, model available' }
        : { success: false, message: 'Connection failed or model unavailable' };
    } catch (error: any) {
      return { success: false, message: error.message || 'Connection failed' };
    }
  }

  // ========== 工具注册 ==========

  registerTool(name: string, definition: ToolDefinition, executor: ToolExecutor): void {
    this.toolRegistry.register({
      definition,
      executor: (args, _ctx) => executor(args, _ctx.sessionId),
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
        return this.executeCommand(args.command as string, ctx.sessionId, (args.timeout as number) || 2000);
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
        return this.readTerminal(ctx.sessionId);
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

  private async executeCommand(command: string, sessionId: string, timeout: number): Promise<string> {
    if (!this.sshService) return 'Error: SSH service not available';
    const session = this.sshService.getSession(sessionId);
    if (!session) return `Error: Session ${sessionId} not found`;

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
    if (!this.sshService) return 'Error: SSH service not available';
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
      write: (data: string) => {
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

  async agentRun(
    ownerId: string,
    sessionId: string,
    userMessage: string,
    context: string | undefined,
    eventCallback: AgentEventCallback,
    skillId?: string,
    locale?: string,
  ): Promise<void> {
    const engine = await this.getEngine(ownerId);
    if (!engine) {
      eventCallback({ type: 'error', error: 'API Key not configured. Please set it in AI settings.' });
      return;
    }

    // 构建 system prompt 覆盖片段
    let systemPromptOverride = '';

    if (locale) {
      const langName = locale.startsWith('zh') ? 'Chinese' : locale.startsWith('ja') ? 'Japanese' : locale.startsWith('ko') ? 'Korean' : 'English';
      systemPromptOverride += `\n\n[User's UI language preference: ${langName} (${locale}). If the user's message language is ambiguous, prefer responding in ${langName}.]`;
    }

    const sysContext = await this.getSessionContext(sessionId);
    if (sysContext && sysContext !== 'Failed to collect system info') {
      systemPromptOverride += `\n\n${sysContext}`;
    }

    if (skillId && this.skillService) {
      const skill = await this.skillService.getSkill(ownerId, skillId);
      if (skill) {
        systemPromptOverride += `\n\n## Current Task Instructions (Skill: ${skill.name})\n\n${skill.content}`;
      }
    }

    // 加载并注入会话历史
    const savedHistory = await this.loadChatMessages(ownerId, sessionId);
    if (savedHistory && savedHistory.length > 0) {
      engine.setHistory(sessionId, savedHistory);
    }

    // AbortController 管理
    const ctrl = new AbortController();
    this.abortControllers.set(this.abortKey(ownerId, sessionId), ctrl);

    try {
      // 注入 shell 执行器：新版 agent-core 的内置 execute_command/read_terminal 走
      // ctx.shell.exec/read，不注入则落到 noop shell（捕不到任何输出）。
      const shellExecutor = this.buildShellExecutor(sessionId);
      const eventStream = engine.run({
        sessionId,
        message: userMessage,
        context: context
          ? { sessionId, terminalOutput: context, custom: { shell: shellExecutor } }
          : { sessionId, custom: { shell: shellExecutor } },
        abortSignal: ctrl.signal,
        systemPromptOverride: systemPromptOverride || undefined,
        skillId,
      });

      for await (const coreEvent of eventStream) {
        const mapped = this.mapCoreEvent(coreEvent);
        if (mapped) eventCallback(mapped);
      }
    } catch (error: any) {
      eventCallback({ type: 'error', error: error.message || 'Agent runtime error' });
    } finally {
      this.abortControllers.delete(this.abortKey(ownerId, sessionId));
      // 持久化 LLM 上下文消息
      try {
        const snapshot = engine.getHistorySnapshot(sessionId);
        if (snapshot && snapshot.length > 0) await this.saveChatMessages(ownerId, sessionId, snapshot);
      } catch { /* ignore */ }
    }
  }

  private abortKey(ownerId: string, sessionId: string): string {
    return `${ownerId}:${sessionId}`;
  }

  stopAgent(ownerId: string, sessionId: string): boolean {
    const ctrl = this.abortControllers.get(this.abortKey(ownerId, sessionId));
    if (ctrl) {
      ctrl.abort();
      this.engines.get(ownerId)?.abort(sessionId);
      return true;
    }
    return false;
  }

  // ========== 非 Agent 对话 ==========

  async chat(ownerId: string, sessionId: string, userMessage: string, context?: string): Promise<string> {
    const provider = await this.ensureLLMProvider(ownerId);
    if (!provider) throw new Error('API Key not configured. Please set it in AI settings.');
    const config = await this.ensureConfig(ownerId);

    const history = (await this.loadChatMessages(ownerId, sessionId)) || [];
    const messages: Message[] = [{ role: 'system', content: AGENT_SYSTEM_PROMPT }];
    if (context) messages.push({ role: 'system', content: `Recent terminal output:\n\`\`\`\n${context}\n\`\`\`` });
    messages.push(...history);
    messages.push({ role: 'user', content: userMessage });
    history.push({ role: 'user', content: userMessage });

    try {
      const response = await provider.chat({
        messages,
        maxTokens: config.maxTokens,
        temperature: config.temperature,
      });
      const content = response.choices?.[0]?.message?.content;
      if (content) {
        const textContent = extractTextFromContent(content);
        history.push({ role: 'assistant', content: textContent });
        await this.saveChatMessages(ownerId, sessionId, history);
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
    sessionId: string,
    userMessage: string,
    context?: string,
  ): AsyncGenerator<string, void, unknown> {
    const provider = await this.ensureLLMProvider(ownerId);
    if (!provider) throw new Error('API Key not configured. Please set it in AI settings.');
    const config = await this.ensureConfig(ownerId);

    const history = (await this.loadChatMessages(ownerId, sessionId)) || [];
    const messages: Message[] = [{ role: 'system', content: AGENT_SYSTEM_PROMPT }];
    if (context) messages.push({ role: 'system', content: `Recent terminal output:\n\`\`\`\n${context}\n\`\`\`` });
    messages.push(...history);
    messages.push({ role: 'user', content: userMessage });
    history.push({ role: 'user', content: userMessage });

    let fullResponse = '';
    try {
      const stream = provider.chatStream({
        messages,
        maxTokens: config.maxTokens,
        temperature: config.temperature,
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
        await this.saveChatMessages(ownerId, sessionId, history);
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
    this.engines.get(ownerId)?.setHistory(sessionId, []);
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

  // ========== 对话历史持久化（前端显示） ==========

  async saveDisplayHistory(ownerId: string, sessionId: string, displayMessages: DisplayMessage[], sessionName?: string): Promise<void> {
    try {
      const firstUser = displayMessages.find(m => m.role === 'user');
      await saveHistory({
        ownerId,
        sessionId,
        sessionName,
        messageCount: displayMessages.length,
        preview: (firstUser?.content || '').substring(0, 80),
        messages: displayMessages,
        savedAt: Date.now(),
      });
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
