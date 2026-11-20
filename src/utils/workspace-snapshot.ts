/**
 * 标签页级工作区快照：刷新页面后把终端 tab 和屏幕上的内容原样恢复。
 *
 * 为什么是 sessionStorage，而不是 localStorage 或服务端：
 * - localStorage 跨标签页、跨浏览器重启都还在，会变成「关掉浏览器 tab 还在」，
 *   与「关掉就彻底丢弃」的预期相反；
 * - 服务端 sessions 表只有元数据，拿不到屏幕内容，而且僵尸行清理后也未必还在；
 * - sessionStorage 的寿命正好是「当前这个标签页」：刷新还在，关闭标签页/浏览器即清空。
 *
 * 存两份数据：
 * 1) `aetherops.workspace.v1`         —— tab 列表（谁、叫什么、哪个是当前 tab）
 * 2) `aetherops.termbuf.v1.<tabId>`   —— 该 tab 最近一段原始输出（终端回放用）
 * 拆开存是因为输出是高频数据，每 1~2 秒刷一次整份快照太浪费。
 */

const WORKSPACE_KEY = 'aetherops.workspace.v1';
const BUFFER_PREFIX = 'aetherops.termbuf.v1.';

/**
 * 单个终端最多回放的字符数。
 * 终端看的是「最近的输出」，保留尾部即可；上限也顺带压住 sessionStorage 配额（约 5MB）。
 */
export const MAX_BUFFER_CHARS = 120_000;

/** 一份快照最多记多少个 tab：超出部分连缓冲一起丢弃，避免吃满配额 */
export const MAX_SNAPSHOT_TABS = 12;

export interface WorkspaceTab {
  id: string;
  connectionId: string;
  connectionName: string;
  cols: number;
  rows: number;
  /** 快照时的服务端会话 id：恢复时顺手把这条遗留 metadata 清掉 */
  sessionId?: string;
}

export interface WorkspaceSnapshot {
  savedAt: number;
  activeTabId: string | null;
  tabs: WorkspaceTab[];
}

/** sessionStorage 在隐私模式 / 沙箱下可能直接抛异常，任何失败都退化成「没有快照」 */
function storage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function bufferKey(tabId: string): string {
  return BUFFER_PREFIX + tabId;
}

export function saveWorkspace(snapshot: WorkspaceSnapshot): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(WORKSPACE_KEY, JSON.stringify(snapshot));
  } catch {
    // 配额满：先清掉所有输出缓冲保住 tab 列表本身，tab 列表才是刷新后不可再生的
    dropAllBuffers();
    try {
      store.setItem(WORKSPACE_KEY, JSON.stringify(snapshot));
    } catch {
      /* 还写不进去就算了，下次操作再试 */
    }
  }
}

export function loadWorkspace(): WorkspaceSnapshot | null {
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(WORKSPACE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as WorkspaceSnapshot;
    // 结构对不上（老版本 / 手改过）就当没有，别拿半份数据把界面拼坏
    if (!parsed || !Array.isArray(parsed.tabs)) return null;
    const tabs = parsed.tabs.filter(
      (tab) => tab && typeof tab.id === 'string' && typeof tab.connectionId === 'string',
    );
    return {
      savedAt: Number(parsed.savedAt) || 0,
      activeTabId: typeof parsed.activeTabId === 'string' ? parsed.activeTabId : null,
      tabs: tabs.slice(0, MAX_SNAPSHOT_TABS),
    };
  } catch {
    return null;
  }
}

/** 退出登录 / 换账号时清空：别人的终端不该出现在同一个浏览器标签页里 */
export function clearWorkspace(): void {
  const store = storage();
  if (!store) return;
  dropAllBuffers();
  try {
    store.removeItem(WORKSPACE_KEY);
  } catch {
    /* ignore */
  }
}

/** 只留这些 tab 的输出缓冲，其余（已关闭的 tab）一并删掉 */
export function pruneTerminalBuffers(keepTabIds: Set<string>): void {
  const store = storage();
  if (!store) return;
  try {
    for (let i = store.length - 1; i >= 0; i--) {
      const key = store.key(i);
      if (!key || !key.startsWith(BUFFER_PREFIX)) continue;
      if (!keepTabIds.has(key.slice(BUFFER_PREFIX.length))) store.removeItem(key);
    }
  } catch {
    /* ignore */
  }
}

export function saveTerminalBuffer(tabId: string, text: string): void {
  const store = storage();
  if (!store || !text) return;
  const tail = tailOf(text);
  try {
    store.setItem(bufferKey(tabId), tail);
  } catch {
    // 配额满：这个 tab 的输出让位，tab 列表和其它 tab 的缓冲优先保留
    try {
      store.removeItem(bufferKey(tabId));
    } catch {
      /* ignore */
    }
  }
}

export function loadTerminalBuffer(tabId: string): string {
  const store = storage();
  if (!store) return '';
  try {
    return store.getItem(bufferKey(tabId)) || '';
  } catch {
    return '';
  }
}

export function dropTerminalBuffer(tabId: string): void {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(bufferKey(tabId));
  } catch {
    /* ignore */
  }
}

function dropAllBuffers(): void {
  const store = storage();
  if (!store) return;
  try {
    for (let i = store.length - 1; i >= 0; i--) {
      const key = store.key(i);
      if (key && key.startsWith(BUFFER_PREFIX)) store.removeItem(key);
    }
  } catch {
    /* ignore */
  }
}

/**
 * 截取能安全回放的尾部。
 *
 * 回放是把原始字节重新灌回 xterm，从半截转义序列开始会污染后面所有输出，
 * 所以尽量从换行之后切；实在找不到换行（一整行超长输出）才硬切。
 */
function tailOf(text: string): string {
  if (text.length <= MAX_BUFFER_CHARS) return text;
  const cut = text.slice(text.length - MAX_BUFFER_CHARS);
  const newlineAt = cut.indexOf('\n');
  return newlineAt === -1 ? cut : cut.slice(newlineAt + 1);
}
