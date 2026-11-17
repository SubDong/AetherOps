/**
 * 错误指纹服务（P4）。
 *
 * 职责边界刻意划得很窄：
 * - 判定「这次算不算失败」与「指纹是多少」全部交给 `utils/fingerprint.ts`（纯函数，
 *   P5 / P6 共用），本类只做「拿到归属 + 落库 + 清理」；
 * - **跟着审计走**：写入点在 agent 的 after_tool 钩子里，与 audit-tool-call 并列。
 *   审计是流水、这张表是聚合，两者失败都必须不影响命令结果；
 * - 只认 `execute_command`：`run_on_hosts` 的结果是 N 台主机拼成的一段文本，而钩子
 *   只有一个 sessionId，硬记会把 5 台机器的错误全算到发起终端那台头上。
 *
 * 为什么没有读接口：本阶段（P4）只写不读 —— 先把数据攒起来，P5 用同一份指纹做
 * 告警去重、P6 做历史召回。留一个 HTTP 端点去暴露一张没人看的表，只是负债。
 */
import { extractFingerprint } from '../utils/fingerprint';
import { pruneErrorFingerprints, upsertErrorFingerprint } from '../db/repositories/error-fingerprint.repo';

/** 一次工具输出的记账入参；字段名与 hook 里的 ctx 对齐 */
export interface FingerprintRecordInput {
  ownerId?: string;
  /** 连接归属；会话已断时为 undefined —— 宁可漏记，也不要写错行 */
  connectionId?: string;
  tool?: string;
  /** 触发它的命令（给人看） */
  command?: string;
  /** 工具输出原文（内部会去 ANSI、取代表行） */
  output?: string;
  /** 引擎判定的工具级错误（agent-core 的 ctx.isError） */
  isError?: boolean;
}

export class FingerprintService {
  /** 与审计保留期对齐：两张表一起清，查的时候不会「有指纹没流水」 */
  private readonly retentionDays = 30;
  /** 一天一次太少（进程可能活不过 24h 就被重启），六小时一次足够便宜 */
  private readonly pruneIntervalMs = 6 * 3600_000;
  private timer: NodeJS.Timeout | null = null;

  /**
   * 启动清理 + 起定时器。必须等库就绪（迁移跑完表才在），
   * 所以由 initServices() 调用，而不是构造函数。
   */
  async init(): Promise<void> {
    await this.prune();
    if (this.timer) return;
    this.timer = setInterval(() => { void this.prune(); }, this.pruneIntervalMs);
    // 不让清理定时器把进程钉住（Electron / VSCode 宿主退出时要能干净退出）
    this.timer.unref?.();
  }

  /** 测试与热重启用：停掉定时器 */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * 记一次工具输出。
   *
   * 永不抛错：调用方是 after_tool 钩子，指纹写失败不能把命令结果搞成失败，
   * 也不能让审计钩子因为同一个异常被跳过。异常只打 warn（带原因，不吞得没影）。
   */
  async record(input: FingerprintRecordInput): Promise<void> {
    try {
      if (!input.ownerId) return;
      if ((input.tool || '') !== 'execute_command') return;
      const connectionId = (input.connectionId || '').trim();
      // 没有连接归属就无法回答「在哪台机器上」，写进去只会污染主键
      if (!connectionId) return;

      const found = extractFingerprint(input.output || '', input.isError === true);
      if (!found) return;

      await upsertErrorFingerprint({
        ownerId: input.ownerId,
        connectionId,
        fingerprint: found.fingerprint,
        sampleText: found.sampleText,
        tool: input.tool || '',
        command: (input.command || '').slice(0, 512),
      });
    } catch (error: any) {
      console.warn(`[FingerprintService] 写入失败（不影响命令结果）: ${error?.message || error}`);
    }
  }

  /** 跑一次清理并返回删除行数（验证脚本直接调它，不必等定时器） */
  async pruneNow(retentionDays = this.retentionDays): Promise<number> {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 3600_000);
    return pruneErrorFingerprints(cutoff);
  }

  private async prune(): Promise<void> {
    try {
      const removed = await this.pruneNow();
      if (removed > 0) {
        console.log(`[FingerprintService] 清理过期指纹 ${removed} 条（保留 ${this.retentionDays} 天）`);
      }
    } catch (error: any) {
      console.error('[FingerprintService] 清理过期指纹失败:', error?.message || error);
    }
  }
}
