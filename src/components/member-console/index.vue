<template>
  <div class="member-mask" @click.self="$emit('close')">
    <div class="member-dialog">
      <div class="member-header">
        <div class="member-title">
          <i class="bi bi-person-gear"></i>
          <span>{{ t('member.title', { username }) }}</span>
          <span class="member-badge">{{ t('member.onlineTerminals', { count: sessions.sockets }) }}</span>
        </div>
        <div class="member-header-right">
          <!-- 紧急断开是「先动手再确认」的反面：一定要 modal 确认，因为它会把人踢下线 -->
          <button class="btn-danger-solid" :disabled="disconnecting" @click="handleDisconnect">
            <i class="bi bi-plug"></i>{{ disconnecting ? t('common.loading') : t('member.disconnect') }}
          </button>
          <button class="btn-icon" :title="t('common.refresh')" @click="reloadCurrent">
            <i class="bi bi-arrow-clockwise"></i>
          </button>
          <button class="btn-icon" :title="t('member.close')" @click="$emit('close')">
            <i class="bi bi-x-lg"></i>
          </button>
        </div>
      </div>

      <div class="member-hint">
        <i class="bi bi-info-circle"></i>{{ t('member.disconnectHint') }}
      </div>

      <div class="member-tabs">
        <button
          v-for="tab in TABS"
          :key="tab"
          class="member-tab"
          :class="{ active: activeTab === tab }"
          @click="switchTab(tab)"
        >
          {{ TAB_LABELS[tab] }}
        </button>
      </div>

      <div class="member-body">
        <div v-if="error" class="member-error">{{ error }}</div>

        <!-- 审计 / 传输：同一份列表，只是过滤条件与列不同 -->
        <template v-if="activeTab === 'audit' || activeTab === 'transfer'">
          <div class="member-filters">
            <input type="date" class="filter-input" v-model="filters.date" @change="loadEntries(true)" />
            <input
              type="text"
              class="filter-input flex-grow-1"
              :placeholder="t('member.keywordPlaceholder')"
              v-model="filters.keyword"
              @keyup.enter="loadEntries(true)"
            />
            <select class="filter-input" v-model="filters.status" @change="loadEntries(true)">
              <option value="">{{ t('audit.allStatus') }}</option>
              <option value="success">{{ t('audit.success') }}</option>
              <option value="error">{{ t('audit.error') }}</option>
              <option value="blocked">{{ t('audit.blocked') }}</option>
            </select>
            <button class="btn-ghost-sm" @click="loadEntries(true)">{{ t('member.query') }}</button>
          </div>

          <div class="member-list">
            <div v-if="loading" class="member-empty">
              <i class="bi bi-hourglass-split"></i>{{ t('common.loading') }}
            </div>
            <div v-else-if="entries.length === 0" class="member-empty">
              <i class="bi bi-inbox"></i>{{ t('member.empty') }}
            </div>
            <table v-else class="member-table">
              <thead>
                <tr>
                  <th>{{ t('member.time') }}</th>
                  <th>{{ t('member.session') }}</th>
                  <th>{{ activeTab === 'transfer' ? t('member.direction') : t('member.tool') }}</th>
                  <th>{{ activeTab === 'transfer' ? t('member.path') : t('audit.command') }}</th>
                  <th>{{ t('member.status') }}</th>
                  <th class="text-end">{{ t('member.duration') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="entry in entries"
                  :key="entry.id"
                  class="row-clickable"
                  :class="'status-' + entry.status"
                  @click="toggleExpand(entry.id)"
                >
                  <td class="nowrap">{{ formatTime(entry.timestamp) }}</td>
                  <td class="ellipsis">{{ entry.sessionName || entry.sessionId || '-' }}</td>
                  <td>{{ activeTab === 'transfer' ? transferDirection(entry) : (entry.tool || '-') }}</td>
                  <td class="ellipsis">{{ activeTab === 'transfer' ? transferPath(entry) : truncate(entry.command) }}</td>
                  <td>
                    <i :class="statusIcon(entry.status)"></i>
                    <span v-if="activeTab === 'transfer'" class="cell-sub">{{ transferSize(entry) }}</span>
                  </td>
                  <td class="text-end nowrap">{{ formatDuration(entry.duration) }}</td>
                </tr>
              </tbody>
            </table>

            <!-- 展开行：结果原文可能很长（传输失败原因、命令输出） -->
            <div v-for="entry in expandedEntries" :key="'d-' + entry.id" class="entry-detail">
              <div class="detail-row">
                <span class="detail-label">{{ t('audit.result') }}:</span>
                <pre class="detail-code">{{ entry.result || '-' }}</pre>
              </div>
            </div>
          </div>

          <div class="member-pager">
            <span class="pager-info">{{ t('audit.total') }}: {{ total }}</span>
            <button class="btn-ghost-sm" :disabled="page <= 1 || loading" @click="goPage(-1)">{{ t('member.prev') }}</button>
            <button class="btn-ghost-sm" :disabled="offset + entries.length >= total || loading" @click="goPage(1)">{{ t('member.next') }}</button>
          </div>
        </template>

        <!-- 连接：只读 + 可删除，凭据在服务端就已剥掉 -->
        <template v-else-if="activeTab === 'connections'">
          <div class="member-list">
            <div v-if="loading" class="member-empty"><i class="bi bi-hourglass-split"></i>{{ t('common.loading') }}</div>
            <div v-else-if="connections.length === 0" class="member-empty"><i class="bi bi-inbox"></i>{{ t('member.noConnections') }}</div>
            <table v-else class="member-table">
              <thead>
                <tr>
                  <th>{{ t('member.name') }}</th>
                  <th>{{ t('member.host') }}</th>
                  <th>{{ t('member.port') }}</th>
                  <th>{{ t('member.user') }}</th>
                  <th>{{ t('member.authType') }}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="conn in connections" :key="conn.id">
                  <td>{{ conn.name }}</td>
                  <td class="ellipsis">{{ conn.type === 'local' ? t('sidebar.localShell') : (conn.host || '-') }}</td>
                  <td>{{ conn.type === 'local' ? '-' : (conn.port || 22) }}</td>
                  <td>{{ conn.username || '-' }}</td>
                  <td>
                    {{ conn.authType || '-' }}
                    <span v-if="conn.hasSecret" class="cell-sub">{{ t('member.credentialsHidden') }}</span>
                  </td>
                  <td class="text-end">
                    <button class="btn-icon danger" :title="t('member.deleteConnection')" @click="removeConnection(conn)">
                      <i class="bi bi-trash"></i>
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>

        <!-- 会话：紧急断开前先看一眼对方到底挂着什么 -->
        <template v-else>
          <div class="member-list">
            <div v-if="loading" class="member-empty"><i class="bi bi-hourglass-split"></i>{{ t('common.loading') }}</div>
            <div v-else-if="sessions.sessions.length === 0" class="member-empty"><i class="bi bi-inbox"></i>{{ t('member.noSessions') }}</div>
            <table v-else class="member-table">
              <thead>
                <tr>
                  <th>{{ t('member.session') }}</th>
                  <th>{{ t('member.tool') }}</th>
                  <th>{{ t('member.time') }}</th>
                  <th>{{ t('member.connectionId') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="item in sessions.sessions" :key="item.sessionId">
                  <td>{{ item.name || item.sessionId }}</td>
                  <td>{{ item.type }}</td>
                  <td>{{ formatCreatedAt(item.createdAt) }}</td>
                  <td class="ellipsis">{{ item.connectionId }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { toast } from '@/utils/toast';
import { modal } from '@/utils/modal';
import type { AuditEntry } from '@/service/audit';
import {
  deleteMemberConnection,
  disconnectUser,
  getMemberAudit,
  getMemberConnections,
  getMemberSessions,
  getMemberTransfers,
  type MemberConnection,
  type MemberSessionsResult,
} from '@/service/admin';

const props = defineProps<{
  userId: string;
  username: string;
}>();

defineEmits<{ (e: 'close'): void }>();

const { t } = useI18n();

type TabKey = 'audit' | 'transfer' | 'connections' | 'sessions';
const TABS: TabKey[] = ['audit', 'transfer', 'connections', 'sessions'];
const PAGE_SIZE = 100;

const activeTab = ref<TabKey>('audit');
const loading = ref(false);
const disconnecting = ref(false);
const error = ref('');

const entries = ref<AuditEntry[]>([]);
const total = ref(0);
const page = ref(1);
const expanded = reactive(new Set<string>());
const connections = ref<MemberConnection[]>([]);
const sessions = ref<MemberSessionsResult>({ sessions: [], sockets: 0 });

const filters = reactive({ date: formatDateStr(new Date()), keyword: '', status: '' });

// 页签名用 computed：切语言时标题要跟着变
const TAB_LABELS = computed<Record<TabKey, string>>(() => ({
  audit: t('member.tabAudit'),
  transfer: t('member.tabTransfer'),
  connections: t('member.tabConnections'),
  sessions: t('member.tabSessions'),
}));

const offset = computed(() => (page.value - 1) * PAGE_SIZE);
const expandedEntries = computed(() => entries.value.filter(e => expanded.has(e.id)));

function formatDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '-' : d.toLocaleString();
}

function formatCreatedAt(value: string | Date): string {
  return formatTime(typeof value === 'string' ? Date.parse(value) : Number(value));
}

function formatDuration(ms: number): string {
  if (!ms && ms !== 0) return '-';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${i === 0 ? value : value.toFixed(1)}${units[i]}`;
}

function truncate(text: string): string {
  if (!text) return '-';
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

function statusIcon(status: string): string {
  switch (status) {
    case 'success': return 'bi bi-check-circle-fill text-success';
    case 'error': return 'bi bi-x-circle-fill text-danger';
    case 'blocked': return 'bi bi-shield-x-fill text-warning';
    case 'rewritten': return 'bi bi-pencil-square text-info';
    default: return 'bi bi-question-circle';
  }
}

/* 传输记录复用 audit_events：command 形如 "UPLOAD /path" / "DOWNLOAD /path"，result 是字节数或错误 */
function transferDirection(entry: AuditEntry): string {
  return entry.command?.startsWith('DOWNLOAD') ? t('member.download') : t('member.upload');
}

function transferPath(entry: AuditEntry): string {
  return (entry.command || '').replace(/^(UPLOAD|DOWNLOAD)\s*/, '') || '-';
}

function transferSize(entry: AuditEntry): string {
  const matched = /^(\d+)\s+bytes$/.exec(entry.result || '');
  return matched ? formatBytes(Number(matched[1])) : '';
}

function toggleExpand(id: string) {
  if (expanded.has(id)) expanded.delete(id);
  else expanded.add(id);
}

async function loadEntries(resetPage = false) {
  if (resetPage) page.value = 1;
  loading.value = true;
  error.value = '';
  try {
    const query = {
      userId: props.userId,
      date: filters.date || undefined,
      keyword: filters.keyword || undefined,
      status: filters.status || undefined,
      limit: PAGE_SIZE,
      offset: offset.value,
    };
    // 传输页签固定按 tool=file-transfer 过滤（服务端也会再钉一次），审计页签不传 tool
    const res = activeTab.value === 'transfer' ? await getMemberTransfers(query) : await getMemberAudit(query);
    entries.value = res.entries || [];
    total.value = res.total || 0;
  } catch (e: any) {
    error.value = e?.message || t('common.failed');
  } finally {
    loading.value = false;
  }
}

async function loadConnections() {
  loading.value = true;
  error.value = '';
  try {
    connections.value = await getMemberConnections(props.userId);
  } catch (e: any) {
    error.value = e?.message || t('common.failed');
  } finally {
    loading.value = false;
  }
}

async function loadSessions() {
  // 头部徽标一直要显示在线数，所以不套 loading，避免整块内容闪一下
  error.value = '';
  try {
    sessions.value = await getMemberSessions(props.userId);
  } catch (e: any) {
    error.value = e?.message || t('common.failed');
  }
}

function switchTab(tab: TabKey) {
  activeTab.value = tab;
  expanded.clear();
  reloadCurrent();
}

function reloadCurrent() {
  if (activeTab.value === 'connections') return loadConnections();
  if (activeTab.value === 'sessions') {
    void loadSessions();
    return;
  }
  void loadEntries(true);
}

function goPage(step: number) {
  page.value = Math.max(1, page.value + step);
  void loadEntries();
}

async function removeConnection(conn: MemberConnection) {
  if (!(await modal.confirm(t('member.deleteConnectionConfirm', { name: conn.name })))) return;
  try {
    await deleteMemberConnection(props.userId, conn.id);
    connections.value = connections.value.filter(c => c.id !== conn.id);
    toast.success(t('common.success'));
  } catch (e: any) {
    error.value = e?.message || t('common.failed');
  }
}

async function handleDisconnect() {
  if (!(await modal.confirm(t('member.disconnectConfirm', { username: props.username })))) return;
  disconnecting.value = true;
  error.value = '';
  try {
    const res = await disconnectUser(props.userId);
    toast.success(t('member.disconnectDone', { sessions: res.closedSessions, sockets: res.closedSockets }));
    await loadSessions();
    if (activeTab.value === 'sessions' || activeTab.value === 'audit') reloadCurrent();
  } catch (e: any) {
    error.value = e?.message || t('common.failed');
  } finally {
    disconnecting.value = false;
  }
}

onMounted(async () => {
  await loadSessions();
  await loadEntries(true);
});
</script>

<style scoped>
.member-mask {
  position: fixed;
  inset: 0;
  /* 必须低于 Bootstrap 弹窗（modal 1055 / backdrop 1050）：
     紧急断开与删连接的二次确认走的是全局 modal.confirm，
     一旦这里高于 1055，确认框会被本层遮罩盖住并吃掉点击，按钮看起来就是「没反应」 */
  z-index: 1040;
  background: rgb(0 0 0 / 55%);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}

.member-dialog {
  display: flex;
  flex-direction: column;
  width: min(1080px, 100%);
  max-height: 100%;
  background: var(--bg-dark, #0d1117);
  border: 1px solid var(--border-color, rgba(240, 246, 252, 0.1));
  border-radius: 8px;
  overflow: hidden;
  color: var(--text-primary, #e6edf3);
  font-size: 12px;
}

.member-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border-color);
}

.member-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
}

.member-badge {
  background: rgb(var(--accent-rgb, 9 132 227) / 18%);
  color: var(--accent, #0d84e3);
  font-size: 10px;
  font-weight: 400;
  padding: 2px 8px;
  border-radius: 8px;
}

.member-header-right {
  display: flex;
  align-items: center;
  gap: 6px;
}

.member-hint {
  padding: 6px 14px;
  font-size: 11px;
  color: var(--text-secondary);
  border-bottom: 1px solid var(--border-color);
}

.member-tabs {
  display: flex;
  gap: 2px;
  padding: 0 10px;
  border-bottom: 1px solid var(--border-color);
}

.member-tab {
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 8px 12px;
  font-size: 12px;
}

.member-tab:hover { color: var(--text-primary); }

.member-tab.active {
  color: var(--accent, #0d84e3);
  border-bottom-color: var(--accent, #0d84e3);
}

.member-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.member-filters {
  display: flex;
  gap: 6px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--border-color);
}

.filter-input {
  background: var(--bg-input, var(--bg-dark));
  border: 1px solid var(--border-color);
  color: var(--text-primary);
  padding: 3px 8px;
  border-radius: 4px;
  font-size: 11px;
  outline: none;
}

.filter-input:focus { border-color: var(--accent); }

.member-list {
  flex: 1;
  min-height: 220px;
  overflow-y: auto;
  padding: 0 14px;
}

.member-empty {
  text-align: center;
  padding: 44px 20px;
  color: var(--text-secondary);
}

.member-empty i { font-size: 22px; display: block; margin-bottom: 8px; }

.member-table {
  width: 100%;
  border-collapse: collapse;
}

.member-table th,
.member-table td {
  padding: 6px 8px;
  border-bottom: 1px solid rgb(var(--overlay-rgb, 240 246 252) / 6%);
  text-align: left;
  vertical-align: top;
}

.member-table th {
  position: sticky;
  top: 0;
  background: var(--bg-dark, #0d1117);
  color: var(--text-secondary);
  font-weight: 500;
  font-size: 11px;
  z-index: 1;
}

.row-clickable { cursor: pointer; }
.row-clickable:hover { background: var(--bg-hover, rgba(255, 255, 255, 0.04)); }

.nowrap { white-space: nowrap; }
.text-end { text-align: right; }

.ellipsis {
  max-width: 360px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cell-sub {
  display: block;
  color: var(--text-secondary);
  font-size: 10px;
}

.status-error { border-left: 2px solid var(--danger, #e5534b); }
.status-blocked { border-left: 2px solid var(--warning-strong, #ed9a21); }

.entry-detail {
  margin: 6px 0 10px;
  padding: 8px;
  background: var(--bg-recess, rgba(255, 255, 255, 0.03));
  border-radius: 4px;
}

.detail-row { display: flex; gap: 6px; }

.detail-label {
  color: var(--text-secondary);
  flex-shrink: 0;
  min-width: 60px;
}

.detail-code {
  flex: 1;
  margin: 0;
  padding: 4px 8px;
  background: var(--bg-recess-strong, rgba(0, 0, 0, 0.3));
  border-radius: 3px;
  font-size: 11px;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 200px;
  overflow-y: auto;
}

.member-pager {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border-top: 1px solid var(--border-color);
}

.pager-info { color: var(--text-secondary); font-size: 11px; }

.member-error {
  padding: 8px 14px;
  color: var(--danger, #e5534b);
  font-size: 11px;
}

.btn-ghost-sm {
  background: none;
  border: 1px solid var(--border-color);
  color: var(--text-secondary);
  padding: 3px 10px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 11px;
}

.btn-ghost-sm:hover:not(:disabled) { color: var(--text-primary); border-color: var(--accent); }
.btn-ghost-sm:disabled { opacity: 0.45; cursor: not-allowed; }

.btn-icon {
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 3px 6px;
  border-radius: 4px;
  font-size: 13px;
}

.btn-icon:hover { background: var(--bg-hover); color: var(--text-primary); }
.btn-icon.danger:hover { color: var(--danger); }

.btn-danger-solid {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  background: rgb(var(--danger-rgb, 229 83 75) / 16%);
  border: 1px solid var(--danger, #e5534b);
  color: var(--danger, #e5534b);
  padding: 3px 10px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 11px;
}

.btn-danger-solid:hover:not(:disabled) { background: rgb(var(--danger-rgb, 229 83 75) / 28%); }
.btn-danger-solid:disabled { opacity: 0.5; cursor: not-allowed; }

.text-success { color: var(--success, #57ab5a); }
.text-danger { color: var(--danger, #e5534b); }
.text-warning { color: var(--warning-strong, #ed9a21); }
.text-info { color: var(--info, #4dabf7); }
</style>
