import { defineStore } from 'pinia';
import { ConnectionService } from '@/service/connection';
import type { ConnectionEntity, TerminalTab } from '@/typings/connection';
import { toast } from '@/utils/toast';
import { modal } from '@/utils/modal';
import * as terminalService from '@/service/terminal';
import {
  MAX_SNAPSHOT_TABS,
  dropTerminalBuffer,
  loadWorkspace,
  pruneTerminalBuffers,
  saveWorkspace,
} from '@/utils/workspace-snapshot';
import i18n from '@/utils/i18n';

const t = (key: string) => i18n.global.t(key);

export type TerminalState = {
  connections: ConnectionEntity[];
  tabs: TerminalTab[];
  activeTabId: string | null;
  loading: boolean;
  sidebarCollapsed: boolean;
};

const connectionService = new ConnectionService();

function getDefaultState(): TerminalState {
  return {
    connections: [],
    tabs: [],
    activeTabId: null,
    loading: false,
    sidebarCollapsed: false,
  };
}

export const useTerminalStore = defineStore('terminal', {
  state: (): TerminalState => getDefaultState(),

  getters: {
    activeTab: (state) => state.tabs.find(t => t.id === state.activeTabId) || null,
    tabCount: (state) => state.tabs.length,
    connectionCount: (state) => state.connections.length,
  },

  actions: {
    // 加载连接列表
    async loadConnections() {
      this.loading = true;
      try {
        const result = await connectionService.getAllConnections();
        if (result?.ret === 0) {
          this.connections = result.data || [];
        } else if (Array.isArray(result)) {
          this.connections = result;
        }
      } catch (e: any) {
        toast.error(e.message || t('sidebar.loadFailed'));
      } finally {
        this.loading = false;
      }
    },

    // 添加连接
    async addConnection(connection: ConnectionEntity) {
      return connectionService.addConnection(connection);
    },

    // 更新连接
    async updateConnection(id: string, updates: Partial<ConnectionEntity>) {
      return connectionService.updateConnection(id, updates);
    },

    // 删除连接
    async deleteConnection(id: string) {
      const confirmed = await modal.confirm(t('sidebar.deleteConfirm'));
      if (!confirmed) return false;
      try {
        await connectionService.deleteConnection(id);
        this.connections = this.connections.filter(c => c.id !== id);
        // 关闭关联的 tabs
        this.tabs = this.tabs.filter(t => t.connectionId !== id);
        this.persistWorkspace();
        toast.success(t('sidebar.deleted'));
        return true;
      } catch (e: any) {
        toast.error(e.message || t('sidebar.deleteFailed'));
        return false;
      }
    },

    // 打开新终端 Tab
    openTab(connection: ConnectionEntity, customName?: string) {
      const tabId = `tab-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
      const tab: TerminalTab = {
        id: tabId,
        connectionId: connection.id || '',
        connectionName: customName || connection.name,
        status: 'connecting',
        cols: connection.terminal?.cols || 80,
        rows: connection.terminal?.rows || 24,
      };
      this.tabs.push(tab);
      this.activeTabId = tabId;
      this.persistWorkspace();
      return tab;
    },

    // 关闭 Tab（同步通知 server 端删除 metadata）
    async closeTab(tabId: string) {
      const tab = this.tabs.find(t => t.id === tabId);
      if (tab?.sessionId) {
        try {
          await terminalService.deleteSession(tab.sessionId);
        } catch (e) {
          console.warn('删除 session 失败:', e);
        }
      }
      // tab 都关了，它的回放缓冲没有意义，留着只占配额
      dropTerminalBuffer(tabId);
      const index = this.tabs.findIndex(t => t.id === tabId);
      if (index === -1) return;
      this.tabs.splice(index, 1);
      if (this.activeTabId === tabId) {
        this.activeTabId = this.tabs.length > 0 ? this.tabs[Math.min(index, this.tabs.length - 1)]?.id || null : null;
      }
      this.persistWorkspace();
    },

    // 更新 Tab 状态
    updateTabStatus(tabId: string, status: TerminalTab['status'], sessionId?: string) {
      const tab = this.tabs.find(t => t.id === tabId);
      if (tab) {
        tab.status = status;
        // sessionId 要跟着快照走：刷新后靠它把服务端遗留的 metadata 清掉
        if (sessionId) tab.sessionId = sessionId;
        if (sessionId) this.persistWorkspace();
      }
    },

    // 切换活动 Tab
    switchTab(tabId: string) {
      this.activeTabId = tabId;
      // 「当前是哪个 tab」也要记：刷新后用户应该回到原来那个终端
      this.persistWorkspace();
    },

    // 切换侧边栏
    toggleSidebar() {
      this.sidebarCollapsed = !this.sidebarCollapsed;
    },

    // 克隆 Tab（复制连接）
    async cloneTab(tabId: string) {
      const tab = this.tabs.find(t => t.id === tabId);
      if (!tab) return;

      if (tab.connectionId === '__local__') {
        // 本地 Shell，直接创建新的
        this.openLocalShell(tab.connectionName);
      } else {
        // SSH 连接，查找对应的连接配置
        const conn = this.connections.find(c => c.id === tab.connectionId);
        if (conn) {
          this.openTab(conn, `${tab.connectionName} - ${t('common.copySuffix')}`);
        }
      }
    },

    // 关闭其他 Tab
    async closeOtherTabs(excludeTabId: string) {
      const tabsToClose = this.tabs.filter(t => t.id !== excludeTabId);
      for (const tab of tabsToClose) {
        if (tab.sessionId) {
          try {
            await terminalService.deleteSession(tab.sessionId);
          } catch (e) {
            console.warn('删除 session 失败:', e);
          }
        }
      }
      this.tabs = this.tabs.filter(t => t.id === excludeTabId);
      this.activeTabId = excludeTabId;
      this.persistWorkspace();
    },

    // 关闭所有 Tab
    async closeAllTabs() {
      for (const tab of this.tabs) {
        if (tab.sessionId) {
          try {
            await terminalService.deleteSession(tab.sessionId);
          } catch (e) {
            console.warn('删除 session 失败:', e);
          }
        }
      }
      for (const tab of this.tabs) dropTerminalBuffer(tab.id);
      this.tabs = [];
      this.activeTabId = null;
      this.persistWorkspace();
    },

    // 重命名 Tab（同步到 server 端）
    async renameTab(tabId: string, newName: string) {
      const tab = this.tabs.find(t => t.id === tabId);
      if (!tab) return;
      tab.connectionName = newName;
      // 同步到 server 端
      if (tab.sessionId) {
        try {
          await terminalService.renameSession(tab.sessionId, newName);
        } catch (e) {
          console.warn('重命名 session 失败:', e);
        }
      }
      this.persistWorkspace();
    },

    /**
     * 把当前 tab 栏写进本标签页的 sessionStorage 快照。
     *
     * 只在「增删改 tab」这类低频动作里调用：输出内容是 terminal-tab 自己按 tab 存的，
     * 一并塞进这里等于每 1 秒重写一遍整份快照。
     */
    persistWorkspace() {
      saveWorkspace({
        savedAt: Date.now(),
        activeTabId: this.activeTabId,
        tabs: this.tabs.slice(0, MAX_SNAPSHOT_TABS).map(t => ({
          id: t.id,
          connectionId: t.connectionId,
          connectionName: t.connectionName,
          cols: t.cols,
          rows: t.rows,
          sessionId: t.sessionId,
        })),
      });
    },

    /**
     * 从本标签页的快照恢复 tab 栏。
     *
     * 返回 true 表示「这份浏览器标签页本来就有工作区」——哪怕它一个 tab 都没有
     * （用户刚关完所有 tab 就刷新了），调用方也不该再自作主张开一个新的。
     * 返回 false 才是真正的首次进入，交给调用方兜底。
     */
    restoreFromWorkspace(): boolean {
      const snapshot = loadWorkspace();
      if (!snapshot) return false;

      const tabs: TerminalTab[] = [];
      // 连接列表没拉到时不做过滤：这时分不清「连接被删了」和「网络刚好失败」，
      // 宁可把一个连不上的 tab 恢复出来，也不能因为一次请求失败把用户的工作区抹掉
      const knownConnections = this.connections.length > 0;
      for (const item of snapshot.tabs) {
        if (knownConnections && item.connectionId !== '__local__' && !this.connections.some(c => c.id === item.connectionId)) continue;
        tabs.push({
          id: item.id,
          connectionId: item.connectionId,
          connectionName: item.connectionName,
          cols: item.cols || 80,
          rows: item.rows || 24,
          sessionId: item.sessionId,
          // 进程随上个页面一起没了，恢复出来的 tab 一律从「连接中」开始
          status: 'connecting',
        });
      }

      pruneTerminalBuffers(new Set(tabs.map(t => t.id)));
      this.tabs = tabs;
      this.activeTabId = snapshot.activeTabId && tabs.some(t => t.id === snapshot.activeTabId)
        ? snapshot.activeTabId
        : tabs[0]?.id || null;
      return true;
    },

    // 创建默认服务器 Shell TAB（不保存到连接列表，每次新建）
    openLocalShell(customName?: string) {
      const LOCAL_SHELL_ID = '__local__';
      // 计算默认服务器 Shell Tab 序号，用于显示名称
      const localCount = this.tabs.filter(t => t.connectionId === LOCAL_SHELL_ID).length;
      const tabName = customName || (localCount === 0 ? t('app.localShell') : `${t('app.localShell')} ${localCount + 1}`);

      const tabId = `tab-local-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
      const tab: TerminalTab = {
        id: tabId,
        connectionId: LOCAL_SHELL_ID,
        connectionName: tabName,
        status: 'connecting',
        cols: 80,
        rows: 24,
      };
      this.tabs.push(tab);
      this.activeTabId = tabId;
      this.persistWorkspace();
      return tab;
    },

    // 获取默认服务器 Shell 连接信息（虚拟连接，不保存）
    getLocalShellConnection(): ConnectionEntity {
      return {
        id: '__local__',
        name: t('app.localShell'),
        type: 'local',
        host: '',
        username: '',
        shell: '',
        terminal: {
          cols: 80, rows: 24, fontSize: 14,
          fontFamily: 'Menlo, Monaco, "Courier New", monospace',
          theme: 'dark',
          cursorStyle: 'block' as 'block' | 'underline' | 'bar',
        },
      };
    },
  },
});
