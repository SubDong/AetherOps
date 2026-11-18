<template>
  <div class="alerts-panel">
    <!-- 顶部：标题 + 待处理数 + 状态筛选 + 刷新 -->
    <div class="alerts-header">
      <div class="alerts-header-left">
        <i class="bi bi-bell"></i>
        <span>{{ t('alerts.title') }}</span>
        <span v-if="counts.open > 0" class="alerts-badge">{{ counts.open }}</span>
      </div>
      <div class="alerts-header-right">
        <select v-model="statusFilter" class="filter-input" @change="load">
          <option value="">{{ t('alerts.all') }}</option>
          <option value="open">{{ t('alerts.statusOpen') }} ({{ counts.open }})</option>
          <option value="acked">{{ t('alerts.statusAcked') }} ({{ counts.acked }})</option>
          <option value="resolved">{{ t('alerts.statusResolved') }} ({{ counts.resolved }})</option>
        </select>
        <button class="btn-alerts" @click="refresh" :title="t('common.refresh')">
          <i class="bi bi-arrow-clockwise"></i>
        </button>
      </div>
    </div>

    <!-- 值班安排（P6）：只用于 webhook 里 @ 谁，不在项目里另建通知渠道 -->
    <div class="oncall-bar">
      <div class="oncall-now">
        <i class="bi bi-person-badge"></i>
        <span v-if="currentOnCall()">{{ t('alerts.onCallNow') }} {{ currentOnCall()!.displayName }}</span>
        <span v-else class="oncall-none">{{ t('alerts.onCallNone') }}</span>
        <span v-if="onCall.length > 0" class="oncall-count">
          {{ t('alerts.onCallWindows', { count: onCall.length }) }}
        </span>
        <button class="btn-alerts oncall-toggle" @click="toggleOnCallEditor" :title="t('alerts.onCallManage')">
          <i class="bi bi-sliders"></i>
        </button>
      </div>
      <div v-if="showOnCall" class="oncall-editor">
        <div class="oncall-hint">{{ t('alerts.onCallHint') }}</div>
        <div v-for="row in onCall" :key="row.userId + ':' + row.startMinute" class="oncall-row">
          <span class="oncall-name">{{ row.displayName }}</span>
          <span class="oncall-window">{{ minuteLabel(row.startMinute) }} – {{ minuteLabel(row.endMinute) }}</span>
          <button class="mute-clear" @click="removeOnCall(row)" :title="t('common.delete')">
            <i class="bi bi-x"></i>
          </button>
        </div>
        <div class="oncall-add">
          <select v-model="onCallDraft.userId" class="filter-input oncall-select">
            <option value="">{{ t('alerts.memberPick') }}</option>
            <option v-for="m in members" :key="m.id" :value="m.id">{{ m.displayName }}</option>
          </select>
          <input v-model="onCallDraft.start" type="time" class="filter-input oncall-time" />
          <span class="oncall-dash">–</span>
          <input v-model="onCallDraft.end" type="time" class="filter-input oncall-time" />
          <button
            class="btn-row"
            :disabled="!onCallDraft.userId || !onCallDraft.start || !onCallDraft.end"
            @click="addOnCall"
          >
            <i class="bi bi-plus-lg"></i>{{ t('common.add') }}
          </button>
        </div>
      </div>
    </div>

    <!-- 生效中的规则级静默 -->
    <div v-if="mutes.length > 0" class="alerts-mutes">
      <span v-for="m in mutes" :key="m.rule" class="mute-chip" :title="m.rule">
        <i class="bi bi-bell-slash"></i>
        <span class="mute-rule">{{ shorten(m.rule, 18) }}</span>
        <span class="mute-until">{{ formatUntil(m.until) }}</span>
        <button class="mute-clear" @click="unmute(m.rule)" :title="t('alerts.unmute')">
          <i class="bi bi-x"></i>
        </button>
      </span>
    </div>

    <!-- 告警列表 -->
    <div class="alerts-list">
      <div v-if="loading && items.length === 0" class="alerts-empty">
        <i class="bi bi-hourglass-split"></i> {{ t('common.loading') }}
      </div>
      <div v-else-if="items.length === 0" class="alerts-empty">
        <i class="bi bi-bell-slash"></i> {{ t('alerts.empty') }}
      </div>
      <div
        v-else
        v-for="item in items"
        :key="item.id"
        class="alert-row"
        :class="['level-' + item.level, 'state-' + item.status]"
      >
        <div class="row-head">
          <span class="level-badge">{{ item.level.toUpperCase() }}</span>
          <span class="state-badge">{{ statusLabel(item.status) }}</span>
          <span v-if="item.incidentId" class="incident-badge" :title="t('alerts.incidentBadge', { id: item.incidentId })">
            <i class="bi bi-diagram-3"></i>#{{ item.incidentId }}
          </span>
          <span class="row-conn" :title="item.connectionId">{{ item.connectionId }}</span>
          <span class="row-count" :title="t('alerts.occurrences')">×{{ item.occurrences }}</span>
          <span class="row-time">{{ formatTime(item.lastSeen) }}</span>
        </div>
        <div class="row-message" :title="item.sampleText || item.message">{{ item.message }}</div>
        <div class="row-meta">
          <span class="row-rule" :title="item.rule">
            <i class="bi bi-funnel"></i>{{ shorten(item.rule, 16) }}
          </span>
          <span>{{ t('alerts.firstSeen') }} {{ formatTime(item.firstSeen) }}</span>
          <span v-if="item.ackedByName || item.ackedBy" class="row-acked">
            {{ t('alerts.ackedBy') }} {{ item.ackedByName || item.ackedBy }}
          </span>
          <span v-if="item.assigneeName || item.assigneeId" class="row-assignee">
            {{ t('alerts.assignee') }} {{ item.assigneeName || item.assigneeId }}
          </span>
          <span v-else class="row-unassigned">{{ t('alerts.unassigned') }}</span>
        </div>
        <div class="row-actions">
          <button
            v-if="item.status === 'open'"
            class="btn-row"
            :disabled="busyId === item.id"
            @click="ack(item)"
          >
            <i class="bi bi-check2"></i>{{ t('alerts.ack') }}
          </button>
          <button
            v-if="item.status !== 'resolved'"
            class="btn-row claim-btn"
            :disabled="busyId === item.id"
            @click="claim(item)"
          >
            <i class="bi bi-hand-index"></i>{{ t('alerts.claim') }}
          </button>
          <select
            v-if="item.status !== 'resolved'"
            class="btn-row assign-select"
            :disabled="busyId === item.id"
            :value="item.assigneeId || ''"
            :title="t('alerts.assignTo')"
            @change="assign(item, $event)"
          >
            <option value="">{{ t('alerts.unassigned') }}</option>
            <option v-for="m in members" :key="m.id" :value="m.id">{{ m.displayName }}</option>
          </select>
          <button
            v-if="item.status !== 'resolved' && !item.incidentId"
            class="btn-row"
            :disabled="busyId === item.id"
            @click="attachIncident(item)"
            :title="t('alerts.attachHint')"
          >
            <i class="bi bi-diagram-3"></i>{{ t('alerts.attach') }}
          </button>
          <button
            v-if="item.status !== 'resolved'"
            class="btn-row"
            :disabled="busyId === item.id"
            @click="resolve(item)"
          >
            <i class="bi bi-check2-all"></i>{{ t('alerts.resolve') }}
          </button>
          <select
            class="btn-row mute-select"
            :disabled="busyId === item.id"
            :value="''"
            @change="mute(item, $event)"
          >
            <option value="">{{ t('alerts.mute') }}</option>
            <option value="30">{{ t('alerts.mute30m') }}</option>
            <option value="120">{{ t('alerts.mute2h') }}</option>
            <option value="1440">{{ t('alerts.mute24h') }}</option>
          </select>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onUnmounted } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  ackAlert,
  assignAlert,
  attachAlertIncident,
  claimAlert,
  clearAlertOnCall,
  listAlertMembers,
  listAlertMutes,
  listAlertOnCall,
  listAlerts,
  muteAlertRule,
  resolveAlert,
  setAlertOnCall,
  unmuteAlertRule,
  type AlertCounts,
  type AlertItem,
  type AlertMember,
  type AlertMute,
  type AlertOnCallWindow,
  type AlertStatus,
} from '@/service/alert';
import { toast } from '@/utils/toast';

const { t } = useI18n();

/** active=false 时停止轮询（面板用 v-show 挂着，不看就别查库） */
const props = defineProps<{ active?: boolean }>();

const items = ref<AlertItem[]>([]);
const counts = ref<AlertCounts>({ open: 0, acked: 0, resolved: 0 });
const mutes = ref<AlertMute[]>([]);
const loading = ref(false);
const statusFilter = ref<AlertStatus | ''>('');
const busyId = ref<number | null>(null);

/** 可指派成员：只含 active 账号；未加载前指派下拉只有「未指派」 */
const members = ref<AlertMember[]>([]);
/** 值班表（全部时间窗）；只影响 webhook 里 @ 谁 */
const onCall = ref<AlertOnCallWindow[]>([]);
const showOnCall = ref(false);
const onCallDraft = ref({ userId: '', start: '09:00', end: '18:00' });

const POLL_MS = 30_000;
let timer: ReturnType<typeof setInterval> | null = null;

async function load() {
  loading.value = true;
  try {
    const res = await listAlerts({ status: statusFilter.value, limit: 100 });
    items.value = res.items;
    counts.value = res.counts;
  } catch (e: any) {
    console.error('Failed to load alerts:', e);
  } finally {
    loading.value = false;
  }
}

async function loadMutes() {
  try {
    mutes.value = await listAlertMutes();
  } catch (e: any) {
    console.error('Failed to load alert mutes:', e);
  }
}

/** 成员名单基本不变：只加载一次，删除/禁用账号后下一次打开面板会自然重拉 */
async function loadMembers() {
  if (members.value.length > 0) return;
  try {
    members.value = await listAlertMembers();
  } catch (e: any) {
    console.error('Failed to load alert members:', e);
  }
}

async function loadOnCall() {
  try {
    onCall.value = await listAlertOnCall();
  } catch (e: any) {
    console.error('Failed to load on-call windows:', e);
  }
}

function refresh() {
  void load();
  void loadMutes();
  void loadMembers();
  void loadOnCall();
}

function stopTimer() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

function startTimer() {
  stopTimer();
  timer = setInterval(refresh, POLL_MS);
}

watch(
  () => props.active,
  (active) => {
    if (active === false) {
      stopTimer();
      return;
    }
    refresh();
    startTimer();
  },
  { immediate: true },
);

onUnmounted(stopTimer);

async function ack(item: AlertItem) {
  busyId.value = item.id;
  try {
    await ackAlert(item.id);
    toast.success(t('alerts.ackDone'));
  } catch (e: any) {
    // 409 = 已经被人确认 / 已解决：刷新看到真实状态即可
    toast.warning(e?.message || String(e));
  } finally {
    busyId.value = null;
    refresh();
  }
}

async function resolve(item: AlertItem) {
  busyId.value = item.id;
  try {
    await resolveAlert(item.id);
    toast.success(t('alerts.resolveDone'));
  } catch (e: any) {
    toast.warning(e?.message || String(e));
  } finally {
    busyId.value = null;
    refresh();
  }
}

/** 认领 = 确认 + 指派给自己；服务端对已解决的行返回 409，刷新即可看到真实状态 */
async function claim(item: AlertItem) {
  busyId.value = item.id;
  try {
    await claimAlert(item.id);
    toast.success(t('alerts.claimDone'));
  } catch (e: any) {
    toast.warning(e?.message || String(e));
  } finally {
    busyId.value = null;
    refresh();
  }
}

/** 指派：选中空值 = 取消指派（服务端把空串当清空） */
async function assign(item: AlertItem, event: Event) {
  const select = event.target as HTMLSelectElement;
  const assigneeId = select.value;
  busyId.value = item.id;
  try {
    await assignAlert(item.id, assigneeId);
    toast.success(assigneeId ? t('alerts.assigned') : t('alerts.assignCleared'));
  } catch (e: any) {
    toast.warning(e?.message || String(e));
    // 失败要把下拉退回去，否则界面会显示一个并未落库的处理人
    select.value = item.assigneeId || '';
  } finally {
    busyId.value = null;
    refresh();
  }
}

/** 人工归并：同主机 30 分钟内有活跃事件就并进去，没有就新建一个 */
async function attachIncident(item: AlertItem) {
  busyId.value = item.id;
  try {
    const result = await attachAlertIncident(item.id);
    toast.success(t('alerts.attachDone', { id: result.incidentId }));
  } catch (e: any) {
    toast.warning(e?.message || String(e));
  } finally {
    busyId.value = null;
    refresh();
  }
}

async function mute(item: AlertItem, event: Event) {
  const select = event.target as HTMLSelectElement;
  const minutes = Number(select.value);
  select.value = '';
  if (!minutes) return;
  busyId.value = item.id;
  try {
    mutes.value = await muteAlertRule(item.rule, minutes);
    toast.success(t('alerts.muteDone', { minutes }));
  } catch (e: any) {
    toast.warning(e?.message || String(e));
  } finally {
    busyId.value = null;
  }
}

async function unmute(rule: string) {
  try {
    mutes.value = await unmuteAlertRule(rule);
    toast.success(t('alerts.unmuteDone'));
  } catch (e: any) {
    toast.warning(e?.message || String(e));
  }
}

/* ---------------- 值班表（P6） ---------------- */

function toggleOnCallEditor() {
  showOnCall.value = !showOnCall.value;
  if (showOnCall.value) {
    void loadMembers();
    void loadOnCall();
  }
}

/** 「HH:MM」→ 当天分钟数；解析失败返回 -1，交给服务端报错前先在前端拦一下 */
function hhmmToMinute(value: string): number {
  const [h, m] = String(value || '').split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return -1;
  return h * 60 + m;
}

/** 1440 = 当天 24:00，pad2 会给出 “24:00”，不再折回 00:00 */
function minuteLabel(minute: number): string {
  const total = Math.max(0, Math.min(1440, minute));
  return `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`;
}

/**
 * 此刻谁在岗。与 alert.service.inOnCallWindow 同一口径：左闭右开，start > end 表示跨零点。
 * 写成普通函数而不是 computed：面板每 30 秒刷新一次，函数在每次渲染时都能拿到当前时间。
 */
function currentOnCall(): AlertOnCallWindow | null {
  const now = new Date();
  const minute = now.getHours() * 60 + now.getMinutes();
  return onCall.value.find((row) => {
    const { startMinute: s, endMinute: e } = row;
    if (s === e) return false;
    return s < e ? minute >= s && minute < e : minute >= s || minute < e;
  }) || null;
}

async function addOnCall() {
  const { userId, start, end } = onCallDraft.value;
  const startMinute = hhmmToMinute(start);
  const endMinute = hhmmToMinute(end);
  if (!userId) return;
  if (startMinute < 0 || endMinute < 0) {
    toast.warning(t('alerts.onCallTimeInvalid'));
    return;
  }
  if (startMinute === endMinute) {
    toast.warning(t('alerts.onCallTimeSame'));
    return;
  }
  try {
    onCall.value = await setAlertOnCall(userId, startMinute, endMinute);
    toast.success(t('alerts.onCallSaved'));
  } catch (e: any) {
    toast.warning(e?.message || String(e));
  }
}

async function removeOnCall(row: AlertOnCallWindow) {
  try {
    onCall.value = await clearAlertOnCall(row.userId, row.startMinute);
    toast.success(t('alerts.onCallRemoved'));
  } catch (e: any) {
    toast.warning(e?.message || String(e));
  }
}

function statusLabel(status: AlertStatus): string {
  if (status === 'open') return t('alerts.statusOpen');
  if (status === 'acked') return t('alerts.statusAcked');
  return t('alerts.statusResolved');
}

function shorten(text: string, max: number): string {
  const value = String(text || '');
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function toDate(value: string | number): Date {
  return new Date(value);
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function formatTime(value: string | number): string {
  const d = toDate(value);
  if (Number.isNaN(d.getTime())) return '-';
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear()
    && d.getMonth() === now.getMonth()
    && d.getDate() === now.getDate();
  const hhmmss = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  return sameDay ? hhmmss : `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${hhmmss}`;
}

function formatUntil(value: string | number): string {
  const d = toDate(value);
  if (Number.isNaN(d.getTime())) return '';
  const minutes = Math.max(1, Math.round((d.getTime() - Date.now()) / 60000));
  return minutes >= 60 ? `${Math.round(minutes / 60)}h` : `${minutes}m`;
}

defineExpose({ refresh });
</script>

<style scoped>
.alerts-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-dark);
  font-size: 12px;
  color: var(--text-primary);
}

.alerts-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-color);
  font-size: 13px;
  font-weight: 500;
}
.alerts-header-left { display: flex; align-items: center; gap: 6px; }
.alerts-header-right { display: flex; align-items: center; gap: 4px; }

.alerts-badge {
  background: var(--danger);
  color: #fff;
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 8px;
  font-weight: 400;
}

.btn-alerts {
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 13px;
}
.btn-alerts:hover { background: var(--bg-hover); color: var(--text-primary); }

.filter-input {
  background: var(--bg-input, var(--bg-dark));
  border: 1px solid var(--border-color);
  color: var(--text-primary);
  padding: 3px 6px;
  border-radius: 4px;
  font-size: 11px;
  outline: none;
  max-width: 120px;
}
.filter-input:focus { border-color: var(--accent); }

.alerts-mutes {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 4px 12px;
  border-bottom: 1px solid var(--border-color);
  background: rgb(var(--overlay-rgb) / 3%);
}
.mute-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  padding: 1px 4px;
  border-radius: 3px;
  background: rgb(var(--warning-rgb) / 12%);
  color: var(--warning-strong);
  max-width: 100%;
}
.mute-rule { font-family: 'JetBrains Mono', monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mute-until { opacity: 0.8; }
.mute-clear {
  background: none;
  border: none;
  color: inherit;
  cursor: pointer;
  padding: 0;
  font-size: 11px;
  line-height: 1;
}

.alerts-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
}

.alerts-empty {
  text-align: center;
  padding: 40px 20px;
  color: var(--text-secondary);
}
.alerts-empty i { font-size: 24px; display: block; margin-bottom: 8px; }

.alert-row {
  padding: 6px 12px;
  border-bottom: 1px solid rgb(var(--overlay-rgb) / 4%);
  border-left: 3px solid transparent;
}
.alert-row.level-critical { border-left-color: var(--danger); }
.alert-row.level-error { border-left-color: var(--warning-strong); }
.alert-row.level-warning { border-left-color: var(--warning); }
.alert-row.state-resolved { opacity: 0.6; }
.alert-row:hover { background: var(--bg-hover); }

.row-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
  color: var(--text-secondary);
}
.level-badge {
  font-weight: 600;
  padding: 1px 5px;
  border-radius: 3px;
  background: rgb(var(--overlay-rgb) / 8%);
}
.level-critical .level-badge { background: rgb(var(--danger-rgb) / 18%); color: var(--danger); }
.level-error .level-badge { background: rgb(var(--warning-strong-rgb) / 18%); color: var(--warning-strong); }
.level-warning .level-badge { background: rgb(var(--warning-rgb) / 18%); color: var(--warning); }

.state-badge { color: var(--text-secondary); }
.state-open .state-badge { color: var(--danger); }
.state-acked .state-badge { color: var(--accent); }

.row-conn {
  max-width: 96px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: 'JetBrains Mono', monospace;
}
.row-count { margin-left: auto; flex-shrink: 0; }
.row-time { flex-shrink: 0; }

.row-message {
  margin: 3px 0 2px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  color: var(--text-primary);
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  word-break: break-all;
}

.row-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 10px;
  color: var(--text-secondary);
}
.row-rule { max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row-acked { color: var(--accent); }
.row-assignee { color: var(--warning); }
.row-unassigned { opacity: 0.7; }

/* incident 徽标：归并到同一件事的告警共用同一个 #id */
.incident-badge {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 0 4px;
  border-radius: 3px;
  background: rgb(var(--accent-rgb) / 15%);
  color: var(--accent);
  font-family: 'JetBrains Mono', monospace;
}
.incident-badge i { font-size: 9px; }

.row-actions {
  display: flex;
  gap: 6px;
  margin-top: 4px;
}
.btn-row {
  background: none;
  border: 1px solid var(--border-color);
  color: var(--text-secondary);
  padding: 1px 6px;
  border-radius: 3px;
  cursor: pointer;
  font-size: 10px;
  display: inline-flex;
  align-items: center;
  gap: 3px;
}
.btn-row:hover:not(:disabled) { background: var(--bg-hover); color: var(--text-primary); }
.btn-row:disabled { opacity: 0.5; cursor: default; }
.mute-select { padding: 1px 4px; }
.claim-btn { border-color: rgb(var(--accent-rgb) / 35%); color: var(--accent); }
.assign-select { max-width: 120px; padding: 1px 4px; background: transparent; }
.assign-select option { background: var(--bg-sidebar); color: var(--text-primary); }

/* 值班条（P6）：一直在顶部，因为「此刻谁在岗」是看告警时的上下文 */
.oncall-bar {
  border-bottom: 1px solid var(--border-color);
  background: rgb(var(--overlay-rgb) / 3%);
  font-size: 10px;
  color: var(--text-secondary);
}
.oncall-now {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 4px 12px;
}
.oncall-now i { font-size: 11px; }
.oncall-none { opacity: 0.7; }
.oncall-count { opacity: 0.7; }
.oncall-toggle { margin-left: auto; font-size: 12px; }
.oncall-editor {
  padding: 2px 12px 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.oncall-hint { font-size: 10px; line-height: 1.4; opacity: 0.75; }
.oncall-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 4px;
  border-radius: 3px;
  background: rgb(var(--overlay-rgb) / 4%);
}
.oncall-name { color: var(--text-primary); }
.oncall-window { font-family: 'JetBrains Mono', monospace; }
.oncall-row .mute-clear { margin-left: auto; }
.oncall-add {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
  margin-top: 2px;
}
.oncall-select { max-width: 130px; }
.oncall-time { max-width: 84px; }
.oncall-dash { opacity: 0.6; }
</style>
