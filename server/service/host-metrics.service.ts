import { SSHService } from './ssh.service';
import type { OneShotChannel } from './ssh.service';
import type { ConnectionService } from './connection.service';
import { SystemStatusService } from './system-status.service';
import type { ServerStatusSnapshot } from './system-status.service';
import { loadConfig } from '../utils/config';
import type { ConnectionEntity } from '../model/connection.entity';
import {
  listMetricHosts,
  listMinuteMetrics,
  purgeMetricsBefore,
  upsertMinuteMetric,
} from '../db/repositories/host-metrics.repo';
import type { MinuteMetricRow } from '../db/repositories/host-metrics.repo';

/**
 * 主机指标留存。
 *
 * 数据从哪来：直接复用 SystemStatusService.collect() —— 面板显示的和存下来的
 * 必须是同一套口径，另写一份采集会立刻出现「面板 40%、报表 65%」这种互相打脸。
 * 代价是复用它的差值逻辑：CPU 占用率依赖两次采样，所以留存的其实是
 * 「距上次采样这段时间的平均占用」，窗口就是采集周期（默认 60s）。
 *
 * 什么时候采：服务端自己定时采，不挂在面板轮询上。挂在面板上等于
 * 「没人看就没数据」，而留存的全部意义就是事后能回看。同一分钟内同一连接
 * 只采一次（多个终端连同一台机器不会重复计数），写入走增量聚合，天然幂等。
 *
 * 两条入口：
 *  1) 活会话优先：有人开着终端的主机走会话通道，零新增登录；
 *  2) 无会话兜底：没人连的机器按连接配置另开一次性通道（默认关闭，见
 *     metrics.offlineSampling）。这条会对目标机产生可见副作用（每分钟多一条
 *     登录记录），所以默认关，并且可以用连接的 sampling='skip' 单独退出。
 *
 * 保留期：默认 7 天。每分钟每主机一行，一台主机 7 天约 1 万行，可以忽略。
 */

/** 采集周期：一分钟一行，对齐分钟桶 */
const COLLECT_INTERVAL_MS = 60 * 1000;
/** 首次采集延后：启动瞬间不该和 SSH 建连、迁移、账号引导抢资源 */
const FIRST_COLLECT_DELAY_MS = 15 * 1000;
/** 单轮并发上限：每次采集要开一条独立 exec 通道，20 个会话同时打会顶住 SSH */
const COLLECT_CONCURRENCY = 4;
/** 保留天数 */
const RETENTION_DAYS = 7;
/** 清理周期 */
const PURGE_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** 返回给 AI 的最大点数：超过就按步长合并，避免 24 小时窗口塞爆上下文 */
const MAX_POINTS = 120;
/** 单次查询的最大窗口（24 小时） */
const MAX_WINDOW_MINUTES = 24 * 60;
/** 阈值口径：报告里「有几成时间处于高位」按这三个数算 */
const CPU_HIGH = 80;
const MEM_HIGH = 90;
const DISK_HIGH = 85;
/**
 * 无会话采集的并发上限。
 * 比会话路径（4）更保守：每一次都是一次完整的 TCP 握手 + 认证，
 * 而不是在已建立的连接上开个 channel。
 */
const OFFLINE_CONCURRENCY = 2;
/**
 * 单轮时间预算。一轮必须在下一轮开始前收尾：
 * 剩下的主机留给下一轮（它们在候选列表里会被排到前面，不会被饿死）。
 */
const OFFLINE_BUDGET_MS = 45 * 1000;
/** 失败退避阶梯（分钟）：连不上 / 采不到的主机不该每分钟被敲一次 */
const OFFLINE_BACKOFF_MS = [1, 2, 4, 8, 15].map((minute) => minute * 60 * 1000);
/**
 * 认证类失败单独一档：撞上目标机的 fail2ban 会把本服务所在 IP 关掉，
 * 连带所有人正在用的终端一起断，代价远大于少几个样本。
 */
const AUTH_BACKOFF_MS = [30, 30, 60].map((minute) => minute * 60 * 1000);

function percent(used: number, total: number): number | null {
  if (!total || total <= 0) return null;
  const value = (used / total) * 100;
  return Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value * 100) / 100)) : null;
}

function round(value: number | null, digits = 2): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** 分钟桶起点（服务端本地时间，与 DATETIME 列同口径） */
function bucketOf(ms: number): Date {
  return new Date(Math.floor(ms / COLLECT_INTERVAL_MS) * COLLECT_INTERVAL_MS);
}

/**
 * 无会话采样的差值基线键。
 * 与会话路径共用 SystemStatusService 的差值逻辑，但基线不能互相污染：
 * 会话那条 key 是 sessionId，这条是 offline:<owner>:<connection>。
 */
function offlineKey(ownerId: string, connectionId: string): string {
  return `offline:${ownerId}:${connectionId}`;
}

/** 走活会话的采集任务 */
interface SessionTask {
  sessionId: string;
  ownerId: string;
  connectionId: string;
  hostname: string;
}

/** 走一次性通道的采集任务 */
interface OfflineTask {
  ownerId: string;
  connectionId: string;
  connection: ConnectionEntity;
  /** `ownerId:connectionId`，与去抖表同键 */
  key: string;
}

/** 一列指标的统计口径 */
export interface MetricStat {
  /** 加权均值（按每分钟的采样次数计权） */
  avg: number | null;
  max: number | null;
  min: number | null;
  /** 峰值出现的时刻 */
  maxAt: number | null;
  /** 后半段均值 - 前半段均值：比「首末单点」抗噪，正数是涨 */
  trend: number | null;
  /** 处于高位阈值的分钟数 */
  highMinutes: number;
}

export interface MetricPoint {
  at: number;
  cpuAvg: number | null;
  cpuMax: number | null;
  memAvg: number | null;
  memMax: number | null;
  diskAvg: number | null;
  diskMax: number | null;
  load1: number | null;
  load5: number | null;
  load15: number | null;
  samples: number;
}

export interface MetricsReport {
  connectionId: string;
  hostname: string;
  /** 窗口起止（毫秒） */
  from: number;
  to: number;
  windowMinutes: number;
  /** 原始分钟桶数 */
  buckets: number;
  /** 是否因为超过 MAX_POINTS 而合并过 */
  downsampled: boolean;
  diskTotalBytes: number | null;
  points: MetricPoint[];
  cpu: MetricStat;
  mem: MetricStat;
  disk: MetricStat;
  load1: MetricStat;
  load5: MetricStat;
  load15: MetricStat;
}

export interface MetricsQueryOptions {
  /** 显式指定连接；缺省时用 sessionId 反查 */
  connectionId?: string;
  sessionId?: string;
  windowMinutes?: number;
}

/** 某台主机有留存数据的概要（scope=all 时用） */
export interface MetricHostSummary {
  connectionId: string;
  hostname: string;
  lastAt: number;
  samples: number;
  latest: MetricPoint | null;
}

export class HostMetricsService {
  private ssh: SSHService;
  private status: SystemStatusService;
  private connections: ConnectionService;
  private collectTimer: ReturnType<typeof setInterval> | null = null;
  private firstTimer: ReturnType<typeof setTimeout> | null = null;
  private purgeTimer: ReturnType<typeof setInterval> | null = null;
  /** `ownerId:connectionId` → 已写入的分钟桶。同一分钟内不重复采集，避免写放大 */
  private writtenBucket = new Map<string, number>();
  /** 无会话采集：`ownerId:connectionId` → 退避结束前不再尝试的时刻 */
  private retryAt = new Map<string, number>();
  /** 无会话采集：连续失败次数（成功即清） */
  private failures = new Map<string, number>();
  /** 失败日志节流：一台机器密码填错不能把日志刷满 */
  private lastFailureLog = new Map<string, number>();
  /** 本次启动时间：无会话采样的首次相位以它为原点 */
  private readonly startedAt = Date.now();
  /** 候选轮转游标：候选数超出一轮预算时，保证尾部主机不会永远轮不到 */
  private offlineCursor = 0;
  private stopped = true;

  constructor(ssh: SSHService, status: SystemStatusService, connections: ConnectionService) {
    this.ssh = ssh;
    this.status = status;
    this.connections = connections;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    // unref：采集是后台附属动作，不该拖住进程退出（node-pty 的清理定时器踩过这个坑）
    this.firstTimer = setTimeout(() => {
      void this.collectOnce();
    }, FIRST_COLLECT_DELAY_MS);
    this.firstTimer.unref?.();

    this.collectTimer = setInterval(() => {
      void this.collectOnce();
    }, COLLECT_INTERVAL_MS);
    this.collectTimer.unref?.();

    this.purgeTimer = setInterval(() => {
      void this.purge();
    }, PURGE_INTERVAL_MS);
    this.purgeTimer.unref?.();

    console.log(
      `[Metrics] 指标留存已启动：每 ${COLLECT_INTERVAL_MS / 1000}s 采集，保留 ${RETENTION_DAYS} 天，`
      + `无会话采集${loadConfig().metrics.offlineSampling ? '已开启' : '未开启（仅采集有终端的主机）'}`,
    );
  }

  stop(): void {
    this.stopped = true;
    if (this.firstTimer) clearTimeout(this.firstTimer);
    if (this.collectTimer) clearInterval(this.collectTimer);
    if (this.purgeTimer) clearInterval(this.purgeTimer);
    this.firstTimer = null;
    this.collectTimer = null;
    this.purgeTimer = null;
  }

  /**
   * 一轮采集。
   *
   * 只采「活着且知道归属」的会话：
   *  - sessions 表里的元数据在重启后仍然存在，但对应的 PTY 已经没了，
   *    照 meta 采会每轮都抛一次「会话不存在」，日志里全是噪音。
   *  - 同一连接开了多个终端只采一次：它们看的是同一台主机，
   *    采多次只会让 samples 虚高。
   *
   * 会话采完之后才跑无会话路径：两台机器都不想重复采，
   * 有活会话的主机必须优先走那条零新增登录的路。
   */
  private async collectOnce(): Promise<void> {
    if (this.stopped) return;
    const bucketMs = bucketOf(Date.now()).getTime();
    const pending: SessionTask[] = [];
    const live = new Set<string>();

    for (const info of this.ssh.getSessions()) {
      const ownerId = this.ssh.getSessionOwner(info.sessionId);
      if (!ownerId || !info.connectionId) continue;
      // 没有活句柄的会话直接跳过，不靠 collect() 抛错来发现
      if (!this.ssh.getSession(info.sessionId)) continue;

      const key = `${ownerId}:${info.connectionId}`;
      // live 与 pending 分开记：即使这一分钟已经采过，这台主机也算「有人连着」，
      // 不能再让无会话路径补一次
      live.add(key);
      if (this.writtenBucket.get(key) === bucketMs) continue;
      if (pending.some((task) => `${task.ownerId}:${task.connectionId}` === key)) continue;
      pending.push({ sessionId: info.sessionId, ownerId, connectionId: info.connectionId, hostname: info.name || '' });
    }

    // 清掉上一分钟的标记，避免 Map 随会话数无限增长
    for (const [key, ms] of this.writtenBucket) {
      if (ms !== bucketMs) this.writtenBucket.delete(key);
    }

    if (pending.length) await this.collectSessions(pending, bucketMs);
    await this.collectOffline(live, bucketMs);
  }

  /** 活会话路径：并发开 exec 通道，同一个 SSH 连接上不会互相干扰 */
  private async collectSessions(pending: SessionTask[], bucketMs: number): Promise<void> {
    let index = 0;
    const worker = async () => {
      while (index < pending.length) {
        const item = pending[index++];
        try {
          const snapshot = await this.status.collect(item.sessionId);
          await this.record(item.ownerId, item.connectionId, snapshot);
          // 写成功才记标记：写库失败时下一轮还能补上（半小时内仍可补，靠 bucket 对齐）
          this.writtenBucket.set(`${item.ownerId}:${item.connectionId}`, bucketMs);
        } catch (error: any) {
          // 采集失败是常态（会话刚关、远端命令不可用），不该刷屏
          console.warn(`[Metrics] 采集失败 ${item.sessionId}: ${error?.message || error}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(COLLECT_CONCURRENCY, pending.length) }, worker));
  }

  /**
   * 无会话采集：给「此刻没人连着的机器」补样本。
   *
   * 全程按连接配置拨号，所以默认关闭（metrics.offlineSampling）；
   * 单台机器不想被采，把连接的 sampling 置为 'skip'。
   * 有活会话的主机不走这里：那台机器已经被会话路径采过了，
   * 两条路都采会让同一分钟出现两个样本、登录次数也翻倍。
   */
  private async collectOffline(live: Set<string>, bucketMs: number): Promise<void> {
    if (!loadConfig().metrics.offlineSampling) return;

    let rows: Array<{ ownerId: string; connection: ConnectionEntity }>;
    try {
      rows = await this.connections.listForSampling();
    } catch (error: any) {
      console.warn(`[Metrics] 读取连接列表失败，本轮跳过无会话采集: ${error?.message || error}`);
      return;
    }

    const now = Date.now();
    const candidates: OfflineTask[] = [];
    for (const { ownerId, connection } of rows) {
      if (!ownerId || !connection?.id) continue;
      // __local__ 是虚拟连接（没有配置行、也没法拨），它的历史只能来自真开着的本地 Shell
      if (connection.id === '__local__') continue;
      if (connection.sampling === 'skip') continue;

      const key = `${ownerId}:${connection.id}`;
      if (live.has(key)) continue;
      if (this.writtenBucket.get(key) === bucketMs) continue;
      if ((this.retryAt.get(key) ?? 0) > now) continue;
      // 刚打开开关的这一分钟内，按连接 ID 哈希把首次登录错开，避免所有主机同一秒齐发；
      // 一分钟后这条判断自然失效，之后靠「一轮一分钟 + 分钟去抖」限频
      if (now - this.startedAt < this.phaseMs(key)) continue;

      candidates.push({ ownerId, connectionId: connection.id, connection, key });
    }
    if (!candidates.length) return;

    // 轮转起点：上一轮被预算挤掉的主机这一轮排到前面，否则候选多于一轮容量时尾部永远轮不到
    const start = this.offlineCursor % candidates.length;
    const ordered = candidates.slice(start).concat(candidates.slice(0, start));

    const roundStart = Date.now();
    let index = 0;
    let processed = 0;
    const worker = async () => {
      while (index < ordered.length) {
        if (Date.now() - roundStart > OFFLINE_BUDGET_MS) {
          // 预算用完就收手：下一轮从这里接着来，不把整轮拖成两分钟
          return;
        }
        const task = ordered[index++];
        processed += 1;
        await this.collectOfflineOne(task, bucketMs);
      }
    };
    await Promise.all(Array.from({ length: Math.min(OFFLINE_CONCURRENCY, ordered.length) }, worker));
    this.offlineCursor = (start + processed) % candidates.length;
  }

  /**
   * 首次采集的相位（0 ~ 59.999s）：同一个连接每次都落在同一相位上（哈希只依赖键）。
   * 它解决的是「刚打开开关那一秒所有主机同时登录」，不是长期限频——
   * 长期靠的是「一轮一分钟 + writtenBucket 分钟去抖」。
   */
  private phaseMs(key: string): number {
    let hash = 2166136261;
    for (let i = 0; i < key.length; i += 1) {
      hash ^= key.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0) % COLLECT_INTERVAL_MS;
  }

  /** 采一台无活会话的主机：握手一次，探测家族 + 取指标共用这条连接 */
  private async collectOfflineOne(task: OfflineTask, bucketMs: number): Promise<void> {
    const { ownerId, connectionId, connection, key } = task;
    let channel: OneShotChannel | null = null;
    try {
      let snapshot: ServerStatusSnapshot;
      if (connection.type === 'local') {
        // 本地连接没有远端可拨：直接读 Node 的 os / statfs，也不经过「默认服务器 Shell」口令门禁
        snapshot = await this.status.collectLocalHost(offlineKey(ownerId, connectionId));
      } else {
        channel = await this.ssh.openOneShot(connection);
        const family = await this.ssh.detectFamilyVia(channel, connection);
        const pipe = channel;
        snapshot = await this.status.probeRemote(
          offlineKey(ownerId, connectionId),
          family,
          (command, timeoutMs) => pipe.exec(command, timeoutMs),
        );
      }
      await this.record(ownerId, connectionId, snapshot);
      this.writtenBucket.set(key, bucketMs);
      this.failures.delete(key);
      this.retryAt.delete(key);
    } catch (error: any) {
      this.noteOfflineFailure(key, connection, error);
    } finally {
      channel?.close();
    }
  }

  /**
   * 无会话采集失败后的退避。
   * 连续失败不该每分钟再敲一次；认证类失败单独放宽到半小时——
   * 被目标机的 fail2ban 关掉 IP，连带的是所有人正在用的终端。
   */
  private noteOfflineFailure(key: string, connection: ConnectionEntity, error: any): void {
    const message = String(error?.message || error);
    const authFailure = /authentication|permission denied|no supported authentication/i.test(message);
    const failures = (this.failures.get(key) || 0) + 1;
    this.failures.set(key, failures);
    const ladder = authFailure ? AUTH_BACKOFF_MS : OFFLINE_BACKOFF_MS;
    const wait = ladder[Math.min(failures, ladder.length) - 1];
    this.retryAt.set(key, Date.now() + wait);

    const lastLog = this.lastFailureLog.get(key) || 0;
    if (Date.now() - lastLog > 10 * 60 * 1000) {
      this.lastFailureLog.set(key, Date.now());
      console.warn(
        `[Metrics] 无会话采集失败 ${connection.host || connection.id}（第 ${failures} 次，`
        + `${Math.round(wait / 60000)} 分钟内不再重试）: ${message}`,
      );
    }
  }

  /**
   * 把一次快照按分钟桶写库。手动触发（调试、以后做「立即采样」按钮）也走这里，
   * 与定时采集共用同一段百分比换算，避免两处口径漂移。
   */
  async record(ownerId: string, connectionId: string, snapshot: ServerStatusSnapshot): Promise<void> {
    if (!ownerId || !connectionId) return;
    const load = snapshot.loadAvg || [];
    await upsertMinuteMetric({
      ownerId,
      connectionId,
      hostname: snapshot.hostname || '',
      bucket: bucketOf(snapshot.at || Date.now()),
      // 首次采样没有上一采样点，占用率是 0 但那是「不知道」：存进去会把这一分钟的均值、最小值永久拉低
      cpuPct: snapshot.cpuSupported && snapshot.cpuPrimed ? round(snapshot.cpuPercent, 2) : null,
      memPct: percent(snapshot.memUsed, snapshot.memTotal),
      diskPct: percent(snapshot.diskUsed, snapshot.diskTotal),
      diskTotalBytes: snapshot.diskTotal > 0 ? snapshot.diskTotal : null,
      diskUsedBytes: snapshot.diskSupported ? snapshot.diskUsed : null,
      load1: Number.isFinite(load[0]) ? round(load[0], 3) : null,
      load5: Number.isFinite(load[1]) ? round(load[1], 3) : null,
      load15: Number.isFinite(load[2]) ? round(load[2], 3) : null,
    });
  }

  /** 保留期清理 */
  private async purge(): Promise<void> {
    try {
      const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
      const removed = await purgeMetricsBefore(cutoff);
      if (removed > 0) console.log(`[Metrics] 清理过期指标 ${removed} 行（保留 ${RETENTION_DAYS} 天）`);
    } catch (error: any) {
      console.warn(`[Metrics] 清理失败: ${error?.message || error}`);
    }
  }

  /**
   * 解析查询目标：显式 connectionId 优先，其次从 sessionId 反查。
   * 两者都拿不到就返回空串，由调用方决定怎么提示。
   */
  resolveConnectionId(options: MetricsQueryOptions): string {
    if (options.connectionId) return options.connectionId;
    if (options.sessionId) return this.ssh.getSession(options.sessionId)?.connectionId || '';
    return '';
  }

  /**
   * 该账号下有留存的主机，连同最后一个分钟桶的读数。
   *
   * `latest` 不能偷懒回 null：监控大屏的主机卡片就直接读它，
   * 回 null 时 CPU / 内存 / 磁盘只能显示 `-`，看上去像采集全挂了。
   */
  async listHosts(ownerId: string, windowMinutes = 60): Promise<MetricHostSummary[]> {
    const since = new Date(Date.now() - Math.max(1, windowMinutes) * 60 * 1000);
    const rows = await listMetricHosts(ownerId, since);
    return rows.map((row) => ({
      connectionId: row.connectionId,
      hostname: row.hostname,
      lastAt: row.lastBucket.getTime(),
      samples: row.samples,
      // 走 toPoints 而不是手工挑字段：大屏与 query_metrics 必须是同一套映射
      latest: this.toPoints([row.latest])[0],
    }));
  }

  /**
   * 查区间序列并算汇总。
   * 返回结构而不是拼好的文本：以后前端画图、测试断言数值都要用到原始点。
   */
  async query(ownerId: string, options: MetricsQueryOptions): Promise<MetricsReport | null> {
    const connectionId = this.resolveConnectionId(options);
    if (!connectionId) return null;
    const windowMinutes = Math.max(1, Math.min(MAX_WINDOW_MINUTES, Math.round(options.windowMinutes || 30)));
    const to = new Date();
    const from = new Date(to.getTime() - windowMinutes * 60 * 1000);

    // 多取一行：窗口左边界可能恰好落在桶边界上，取到就能少一次差一错误
    const rows = await listMinuteMetrics(ownerId, connectionId, from, to);
    if (!rows.length) {
      return {
        connectionId,
        hostname: '',
        from: from.getTime(),
        to: to.getTime(),
        windowMinutes,
        buckets: 0,
        downsampled: false,
        diskTotalBytes: null,
        points: [],
        cpu: this.emptyStat(),
        mem: this.emptyStat(),
        disk: this.emptyStat(),
        load1: this.emptyStat(),
        load5: this.emptyStat(),
        load15: this.emptyStat(),
      };
    }

    const points = this.toPoints(rows);
    const { points: sampled, downsampled } = this.downsample(points, MAX_POINTS);
    const mid = Math.floor(points.length / 2);
    const firstHalf = points.slice(0, mid);
    const secondHalf = points.slice(mid);
    // 容量取**最后**一个非空值：扩了容/换了盘要能立刻反映，取最早值会一直读旧容量
    let diskTotalBytes: number | null = null;
    for (const row of rows) {
      if (row.diskTotalBytes !== null) diskTotalBytes = row.diskTotalBytes;
    }

    return {
      connectionId,
      hostname: rows[rows.length - 1].hostname,
      from: from.getTime(),
      to: to.getTime(),
      windowMinutes,
      buckets: rows.length,
      downsampled,
      diskTotalBytes,
      points: sampled,
      cpu: this.stat(rows, (r) => r.cpuPctAvg, (r) => r.cpuPctMax, CPU_HIGH, (p) => p.cpuAvg, firstHalf, secondHalf),
      mem: this.stat(rows, (r) => r.memPctAvg, (r) => r.memPctMax, MEM_HIGH, (p) => p.memAvg, firstHalf, secondHalf),
      disk: this.stat(rows, (r) => r.diskPctAvg, (r) => r.diskPctMax, DISK_HIGH, (p) => p.diskAvg, firstHalf, secondHalf),
      load1: this.stat(rows, (r) => r.load1Avg, (r) => r.load1Max, Number.POSITIVE_INFINITY, (p) => p.load1, firstHalf, secondHalf),
      load5: this.stat(rows, (r) => r.load5Avg, (r) => r.load5Max, Number.POSITIVE_INFINITY, (p) => p.load5, firstHalf, secondHalf),
      load15: this.stat(rows, (r) => r.load15Avg, (r) => r.load15Max, Number.POSITIVE_INFINITY, (p) => p.load15, firstHalf, secondHalf),
    };
  }

  private emptyStat(): MetricStat {
    return { avg: null, max: null, min: null, maxAt: null, trend: null, highMinutes: 0 };
  }

  private toPoints(rows: MinuteMetricRow[]): MetricPoint[] {
    return rows.map((row) => ({
      at: row.bucket.getTime(),
      cpuAvg: row.cpuPctAvg,
      cpuMax: row.cpuPctMax,
      memAvg: row.memPctAvg,
      memMax: row.memPctMax,
      diskAvg: row.diskPctAvg,
      diskMax: row.diskPctMax,
      load1: row.load1Avg,
      load5: row.load5Avg,
      load15: row.load15Avg,
      samples: row.samples,
    }));
  }

  /**
   * 超过 maxPoints 就按步长合并：avg 取算术平均、max 取最大、samples 相加。
   * 这里用算术平均而不是按 samples 计权 —— 已合并的行 samples 各不相同，
   * 再计权会把某些点放大成主导项，读数反而不直观。
   */
  private downsample(points: MetricPoint[], maxPoints: number): { points: MetricPoint[]; downsampled: boolean } {
    if (points.length <= maxPoints) return { points, downsampled: false };
    const step = Math.ceil(points.length / maxPoints);
    const merged: MetricPoint[] = [];
    for (let i = 0; i < points.length; i += step) {
      const chunk = points.slice(i, i + step);
      const avgOf = (pick: (p: MetricPoint) => number | null) => {
        const values = chunk.map(pick).filter((v): v is number => v !== null);
        return values.length ? round(values.reduce((a, b) => a + b, 0) / values.length) : null;
      };
      const maxOf = (pick: (p: MetricPoint) => number | null) => {
        const values = chunk.map(pick).filter((v): v is number => v !== null);
        return values.length ? Math.max(...values) : null;
      };
      merged.push({
        at: chunk[0].at,
        cpuAvg: avgOf((p) => p.cpuAvg),
        cpuMax: maxOf((p) => p.cpuMax),
        memAvg: avgOf((p) => p.memAvg),
        memMax: maxOf((p) => p.memMax),
        diskAvg: avgOf((p) => p.diskAvg),
        diskMax: maxOf((p) => p.diskMax),
        load1: avgOf((p) => p.load1),
        load5: avgOf((p) => p.load5),
        load15: avgOf((p) => p.load15),
        samples: chunk.reduce((sum, p) => sum + p.samples, 0),
      });
    }
    return { points: merged, downsampled: true };
  }

  /**
   * 一列指标的统计。
   * avg 按 samples 计权：同一分钟内采了 3 次，它在均值里的权重就该是 3。
   */
  private stat(
    rows: MinuteMetricRow[],
    pickAvg: (row: MinuteMetricRow) => number | null,
    pickMax: (row: MinuteMetricRow) => number | null,
    highThreshold: number,
    pickPointAvg: (point: MetricPoint) => number | null,
    firstHalf: MetricPoint[],
    secondHalf: MetricPoint[],
  ): MetricStat {
    let weightedSum = 0;
    let weight = 0;
    let max: number | null = null;
    let min: number | null = null;
    let maxAt: number | null = null;
    let highMinutes = 0;

    for (const row of rows) {
      const avg = pickAvg(row);
      if (avg !== null) {
        const w = row.samples > 0 ? row.samples : 1;
        weightedSum += avg * w;
        weight += w;
        if (min === null || avg < min) min = avg;
      }
      const peak = pickMax(row);
      if (peak !== null && (max === null || peak > max)) {
        max = peak;
        maxAt = row.bucket.getTime();
      }
      if (Number.isFinite(highThreshold) && avg !== null && avg >= highThreshold) highMinutes += row.samples || 1;
    }

    const halfAvg = (list: MetricPoint[]) => {
      const values = list.map(pickPointAvg).filter((v): v is number => v !== null);
      return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
    };
    const before = halfAvg(firstHalf);
    const after = halfAvg(secondHalf);

    return {
      avg: weight > 0 ? round(weightedSum / weight) : null,
      max: round(max),
      min: round(min),
      maxAt,
      trend: before !== null && after !== null ? round(after - before) : null,
      highMinutes,
    };
  }

  /**
   * 渲染成给模型读的紧凑文本。
   *
   * 为什么要自己排版而不是回 JSON：点位是数字矩阵，JSON 的字段名会把上下文
   * 撑大好几倍；这里一列一个指标，模型扫一眼就能看出「哪一行开始变红」。
   */
  formatReport(report: MetricsReport, options: { hosts?: MetricHostSummary[] } = {}): string {
    const pad = (value: string, width: number) => value.padEnd(width, ' ');
    const time = (ms: number) => new Date(ms).toISOString().slice(11, 16);
    const stamp = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');

    if (!report.buckets) {
      const lines = [
        `No metrics recorded for connection "${report.connectionId}" in the last ${report.windowMinutes} min.`,
        'The collector samples every 60s, and covers connections that have an open terminal session.',
        'Hosts nobody is connected to are only sampled when metrics.offlineSampling is enabled in the server config.',
        'If this host was just connected (or sits idle without a terminal), wait about a minute or open a terminal and retry.',
      ];
      if (options.hosts?.length) {
        lines.push('', 'Hosts that do have recent data:');
        for (const host of options.hosts) {
          lines.push(`  - ${host.connectionId}${host.hostname ? ` (${host.hostname})` : ''} last sample ${stamp(host.lastAt)}`);
        }
      }
      return lines.join('\n');
    }

    const out: string[] = [];
    out.push(`Host: ${report.hostname || '(unknown)'} | connection: ${report.connectionId}`);
    out.push(
      `Window: last ${report.windowMinutes} min | ${stamp(report.from)} .. ${stamp(report.to)} (UTC) | `
      + `${report.buckets} minute buckets${report.downsampled ? `, merged into ${report.points.length} rows for readability` : ''}`,
    );
    if (report.diskTotalBytes) {
      out.push(`Disk capacity: ${(report.diskTotalBytes / 1024 ** 3).toFixed(1)} GiB`);
    }
    out.push('');
    out.push(`${pad('time', 6)} ${pad('cpu%(avg/max)', 15)} ${pad('mem%(avg/max)', 15)} ${pad('disk%(avg/max)', 16)} load 1/5/15`);
    for (const point of report.points) {
      const cell = (avg: number | null, max: number | null) => (
        avg === null && max === null ? '-' : `${avg ?? '-'}/${max ?? '-'}`
      );
      const loads = [point.load1, point.load5, point.load15].map((v) => (v === null ? '-' : v.toFixed(2))).join('/');
      out.push(
        `${pad(time(point.at), 6)} ${pad(cell(point.cpuAvg, point.cpuMax), 15)} `
        + `${pad(cell(point.memAvg, point.memMax), 15)} ${pad(cell(point.diskAvg, point.diskMax), 16)} ${loads}`,
      );
    }

    const describe = (label: string, stat: MetricStat, unit: string, threshold: number) => {
      if (stat.avg === null && stat.max === null) return;
      const bits = [
        `avg ${stat.avg ?? '-'}${unit}`,
        `max ${stat.max ?? '-'}${unit}${stat.maxAt ? ` at ${time(stat.maxAt)}` : ''}`,
        `min ${stat.min ?? '-'}${unit}`,
      ];
      if (stat.trend !== null) {
        const dir = stat.trend > 0 ? 'up' : stat.trend < 0 ? 'down' : 'flat';
        bits.push(`trend ${stat.trend > 0 ? '+' : ''}${stat.trend}${unit} (${dir})`);
      }
      if (Number.isFinite(threshold) && stat.highMinutes > 0) {
        bits.push(`${stat.highMinutes} min >= ${threshold}${unit}`);
      }
      out.push(`  ${pad(label, 6)} ${bits.join(', ')}`);
    };

    out.push('');
    out.push('Summary (trend = second-half average - first-half average):');
    describe('cpu', report.cpu, '%', CPU_HIGH);
    describe('mem', report.mem, '%', MEM_HIGH);
    describe('disk', report.disk, '%', DISK_HIGH);
    describe('load1', report.load1, '', Number.POSITIVE_INFINITY);
    describe('load5', report.load5, '', Number.POSITIVE_INFINITY);
    describe('load15', report.load15, '', Number.POSITIVE_INFINITY);
    out.push('  "-" means the metric is not available on that host (e.g. load average does not exist on Windows).');
    return out.join('\n');
  }
}
