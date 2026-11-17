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
          <span v-if="item.ackedBy" class="row-acked">{{ t('alerts.ackedBy') }} {{ item.ackedBy }}</span>
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
  listAlertMutes,
  listAlerts,
  muteAlertRule,
  resolveAlert,
  unmuteAlertRule,
  type AlertCounts,
  type AlertItem,
  type AlertMute,
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

function refresh() {
  void load();
  void loadMutes();
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
</style>
