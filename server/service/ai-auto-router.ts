/**
 * Auto 模型路由：按任务复杂度给这一轮挑一个成本档位，再映射到具体配置。
 *
 * 为什么不做「小模型先判断该用哪个模型」：那要多一次调用，而省 token 恰恰是
 * 初衷，多花的这次调用往往比省下来的还贵。这里用本地规则打分，零调用成本。
 *
 * 打分维度（命中即累加，上限映射到 1-5 档）：
 * - 指令长度：长指令通常意味着多步任务
 * - 是否含代码块 / 脚本
 * - 是否要求「动手」而不是「解释」（执行意图词）
 * - 是否在排障（报错、异常、失败……）
 * - 终端上下文是否很长
 * - 本会话已经连续用了多次工具（深链路任务）
 *
 * 档位语义由用户在设置页给每个模型标注（1=最便宜 … 5=最强），
 * 服务端不维护任何价格表：各家的定价随时会变，硬编码进去只会过期。
 */

export interface AutoRouterProfile {
  id: string;
  label: string;
  model: string;
  /** 1=最便宜 … 5=最强 */
  costTier: number;
}

export interface AutoRouteInput {
  message: string;
  /** 随消息带过来的终端输出 */
  context?: string;
  /** 本会话此前已发生的工具调用次数 */
  priorToolCalls?: number;
  /** 已保存的历史消息条数 */
  historyLength?: number;
}

export interface AutoRouteDecision {
  /** 目标档位 1-5 */
  tier: number;
  score: number;
  /** 命中的理由，用于日志与前端展示（让用户知道为什么用这个模型） */
  reasons: string[];
}

/** 路由自适应用的实测统计（来自 ai_usage） */
export interface ModelHealthStat {
  calls: number;
  okCalls: number;
}

/** 样本太少时失败率没有意义：调一次失败就是 100% 失败率 */
const MIN_HEALTH_SAMPLES = 5;

const EXECUTION_HINTS: RegExp[] = [
  /(执行|运行|跑一下|启动|重启|停止|杀掉|安装|部署|卸载|清理|删除|修改|替换|修复|排查|诊断|定位|优化|迁移|备份|恢复|配置|打包|编译|构建|抓取|监控)/,
  /\b(run|exec|install|deploy|restart|start|stop|kill|delete|remove|edit|replace|fix|debug|diagnose|optimi[sz]e|migrate|backup|restore|build|compile|configure|tail|grep|find|curl|docker|systemctl|kubectl|ssh|scp)\b/i,
];

const ERROR_HINTS: RegExp[] = [
  /(报错|错误|异常|失败|崩溃|超时|拒绝|权限不足|找不到|不生效|无法|卡住|死循环|内存溢出)/,
  /\b(error|exception|failed|failure|panic|traceback|timeout|refused|denied|not found|crash|oom|segfault)\b/i,
];

/**
 * 纯函数：只依赖入参，方便单测与复现。
 * 分值刻意做得粗（只有 0-6 分），因为「精确估计任务难度」本身做不到，
 * 粗档位至少能保证行为可预测、可解释。
 */
export function scoreTaskComplexity(input: AutoRouteInput): AutoRouteDecision {
  const reasons: string[] = [];
  let score = 0;

  const message = input.message || '';
  const context = input.context || '';

  if (message.length >= 800) {
    score += 2;
    reasons.push('long-prompt');
  } else if (message.length >= 300) {
    score += 1;
    reasons.push('medium-prompt');
  }

  if (/```/.test(message)) {
    score += 1;
    reasons.push('has-code');
  }

  if (EXECUTION_HINTS.some((re) => re.test(message))) {
    score += 1;
    reasons.push('wants-action');
  }

  if (ERROR_HINTS.some((re) => re.test(message))) {
    score += 1;
    reasons.push('troubleshooting');
  }

  if (context.length >= 2000) {
    score += 1;
    reasons.push('large-context');
  }

  if ((input.priorToolCalls || 0) >= 4) {
    score += 1;
    reasons.push('deep-tool-chain');
  }

  if ((input.historyLength || 0) >= 12) {
    score += 1;
    reasons.push('long-conversation');
  }

  const tier = Math.min(5, Math.max(1, 1 + Math.min(score, 4)));
  if (!reasons.length) reasons.push('short-question');
  return { tier, score, reasons };
}

/**
 * 按「离目标档位最近」排序：同距离时便宜的先试。
 *
 * 用距离而不是「大于等于目标档的最小者」，是为了在目标档没有可用模型时
 * 自然落到次近的配置，而不是一头撞到最贵的那个。
 *
 * health 是近几天的实测成功率（按 modelId）。档位只能表达「模型值多少钱」，
 * 表达不了「这个模型在你这里能不能跑通」：一个 Key 快过期、或者网关老超时的
 * 便宜模型如果永远排第一，auto 就会反复降级、每次都白烧一轮。
 * 所以把失败率折算成距离上的一项惩罚，让它往下沉，而不是从候选里删掉——
 * 只有它可用时仍然选它。
 */
export function rankProfilesForTier<T extends AutoRouterProfile>(
  profiles: T[],
  tier: number,
  health?: Map<string, ModelHealthStat>,
): T[] {
  return [...profiles].sort((a, b) => {
    const da = Math.abs(a.costTier - tier) + healthPenalty(a.id, health);
    const db = Math.abs(b.costTier - tier) + healthPenalty(b.id, health);
    if (da !== db) return da - db;
    return a.costTier - b.costTier;
  });
}

/** 惩罚分：≥30% 失败排到同距离之外，小幅高于 15% 略降，几乎不失败略升 */
function healthPenalty(id: string, health?: Map<string, ModelHealthStat>): number {
  const stat = health?.get(id);
  if (!stat || stat.calls < MIN_HEALTH_SAMPLES) return 0;
  const failRate = 1 - stat.okCalls / stat.calls;
  if (failRate >= 0.3) return 2;
  if (failRate >= 0.15) return 0.6;
  if (failRate <= 0.05) return -0.2;
  return 0;
}

/** 给日志用的一行摘要 */
export function describeAutoRoute(decision: AutoRouteDecision, picked?: AutoRouterProfile): string {
  const target = picked ? `${picked.label || picked.model}(${picked.id}, tier=${picked.costTier})` : '(none)';
  return `tier=${decision.tier} score=${decision.score} pick=${target} reasons=${decision.reasons.join(',')}`;
}
