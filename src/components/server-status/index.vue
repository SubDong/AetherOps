<template>
  <div class="server-status">
    <div class="ss-header">
      <span class="ss-title"><i class="bi bi-speedometer2"></i>{{ t('server.title') }}</span>
      <div class="ss-actions">
        <button class="ss-icon-btn" :class="{ spinning: polling }" :title="t('common.refresh')" @click="poll">
          <i class="bi bi-arrow-clockwise"></i>
        </button>
        <!-- 悬浮 / 停靠：悬浮后从左侧边栏里脱出来，独立成一个能满页拖动的板块 -->
        <button
          class="ss-icon-btn"
          :class="{ active: floating }"
          :title="floating ? t('server.dock') : t('server.float')"
          @click="$emit('toggle-float')"
        >
          <i :class="floating ? 'bi bi-layout-sidebar-inset' : 'bi bi-pip'"></i>
        </button>
        <button class="ss-icon-btn" :title="t('common.close')" @click="$emit('close')">
          <i class="bi bi-x-lg"></i>
        </button>
      </div>
    </div>

    <div class="ss-body">
      <div v-if="!data && loading" class="ss-state">
        <span class="spinner-border spinner-border-sm"></span>{{ t('server.loading') }}
      </div>

      <div v-else-if="!data && error" class="ss-state ss-state-error">
        <i class="bi bi-exclamation-triangle"></i>
        <span class="ss-error-text">{{ error }}</span>
        <button class="ss-retry" @click="poll">{{ t('server.retry') }}</button>
      </div>

      <template v-else-if="data">
        <!-- 系统信息 -->
        <div class="ss-card">
          <div class="ss-host">
            <i class="bi bi-hdd-network"></i>
            <span class="ss-host-name">{{ data.hostname || connectionName || '-' }}</span>
          </div>
          <div v-if="data.os" class="ss-line">
            <i class="bi bi-info-circle"></i><span>{{ t('server.os') }}: {{ data.os }}</span>
            <!-- 自识别结果做成徽标：同一份数据来自哪套采集脚本，一眼能看出来 -->
            <em v-if="osFamilyLabel" class="ss-badge" :class="`family-${data.osFamily}`">{{ osFamilyLabel }}</em>
          </div>
          <div v-if="data.cpuModel" class="ss-line">
            <i class="bi bi-cpu"></i><span>{{ t('server.cpu') }}: {{ data.cpuModel }}</span>
          </div>
          <div v-if="data.uptimeSec" class="ss-line">
            <i class="bi bi-clock-history"></i><span>{{ t('server.uptime') }} {{ uptimeText }}</span>
          </div>
        </div>

        <!-- 四项指标：采不到的那项显示「不可用」，别用 0 骗人 -->
        <div class="ss-grid">
          <div class="ss-metric">
            <div class="ss-metric-head">
              <span><i class="bi bi-cpu"></i>{{ t('server.cpu') }}</span>
              <b :class="{ dim: !data.cpuSupported }">{{ data.cpuSupported ? `${Math.round(data.cpuPercent)}%` : '-' }}</b>
            </div>
            <div class="ss-bar"><i v-if="data.cpuSupported" :style="{ width: barWidth(data.cpuPercent), background: barColor(data.cpuPercent) }"></i></div>
            <div class="ss-metric-foot" :class="{ dim: !data.cpuSupported }">
              {{ data.cpuSupported ? `${t('server.usage')} ${fmtPercent(data.cpuPercent)}` : t('server.cpuUnavailable') }}
            </div>
          </div>

          <div class="ss-metric">
            <div class="ss-metric-head">
              <span><i class="bi bi-memory"></i>{{ t('server.mem') }}</span>
              <b :class="{ dim: !data.memSupported }">{{ data.memSupported ? `${Math.round(memPercent)}%` : '-' }}</b>
            </div>
            <div class="ss-bar"><i v-if="data.memSupported" :style="{ width: barWidth(memPercent), background: barColor(memPercent) }"></i></div>
            <div class="ss-metric-foot" :class="{ dim: !data.memSupported }">
              {{ data.memSupported ? `${fmtBytes(data.memUsed)} / ${fmtBytes(data.memTotal)}` : t('server.memUnavailable') }}
            </div>
          </div>

          <div class="ss-metric">
            <div class="ss-metric-head">
              <span><i class="bi bi-arrow-left-right"></i>{{ t('server.swap') }}</span>
              <b :class="{ dim: !data.swapSupported }">{{ data.swapSupported ? `${Math.round(swapPercent)}%` : '-' }}</b>
            </div>
            <div class="ss-bar"><i v-if="data.swapSupported" :style="{ width: barWidth(swapPercent), background: barColor(swapPercent) }"></i></div>
            <div class="ss-metric-foot" :class="{ dim: !data.swapSupported }">
              {{ data.swapSupported ? `${fmtBytes(data.swapUsed)} / ${fmtBytes(data.swapTotal)}` : t('server.swapUnavailable') }}
            </div>
          </div>

          <div class="ss-metric" :title="data.diskMount">
            <div class="ss-metric-head">
              <span><i class="bi bi-device-hdd"></i>{{ t('server.disk') }}</span>
              <b :class="{ dim: !data.diskSupported }">{{ data.diskSupported ? `${Math.round(diskPercent)}%` : '-' }}</b>
            </div>
            <div class="ss-bar"><i v-if="data.diskSupported" :style="{ width: barWidth(diskPercent), background: barColor(diskPercent) }"></i></div>
            <div class="ss-metric-foot" :class="{ dim: !data.diskSupported }">
              {{ data.diskSupported ? `${fmtBytes(data.diskUsed)} / ${fmtBytes(data.diskTotal)}` : t('server.diskUnavailable') }}
            </div>
          </div>
        </div>

        <!-- 网络 -->
        <div class="ss-card">
          <div class="ss-net-head">
            <span><i class="bi bi-diagram-3"></i>{{ t('server.net') }}</span>
            <code v-if="data.netSupported">{{ netIfaceLabel || '-' }}</code>
          </div>
          <div v-if="data.netSupported" class="ss-net-row">
            <div class="ss-net-item down">
              <i class="bi bi-arrow-down-circle"></i>
              <span>{{ t('server.download') }}</span>
              <b>{{ fmtSpeed(data.netRxBps) }}</b>
            </div>
            <div class="ss-net-item up">
              <i class="bi bi-arrow-up-circle"></i>
              <span>{{ t('server.upload') }}</span>
              <b>{{ fmtSpeed(data.netTxBps) }}</b>
            </div>
          </div>
          <!-- 采不到就明说，不要整块消失让人以为没这个指标 -->
          <div v-else class="ss-line dim">
            <i class="bi bi-slash-circle"></i><span>{{ t('server.netUnavailable') }}</span>
          </div>
        </div>

        <!-- CPU 使用率曲线（采不到时不画一条贴着 0 的假曲线） -->
        <div v-if="data.cpuSupported" class="ss-card ss-chart-card">
          <div class="ss-chart-head">
            <span><i class="bi bi-graph-up"></i>{{ t('server.cpuUsage') }}</span>
            <b>{{ fmtPercent(data.cpuPercent) }}</b>
          </div>
          <svg class="ss-chart" viewBox="0 0 100 40" preserveAspectRatio="none">
            <line x1="0" y1="10" x2="100" y2="10" class="ss-grid-line" />
            <line x1="0" y1="20" x2="100" y2="20" class="ss-grid-line" />
            <line x1="0" y1="30" x2="100" y2="30" class="ss-grid-line" />
            <polygon v-if="cpuArea" :points="cpuArea" class="ss-area cpu" />
            <polyline v-if="cpuPoints" :points="cpuPoints" class="ss-line-path cpu" vector-effect="non-scaling-stroke" />
          </svg>
          <div class="ss-axis"><span>0</span><span>50</span><span>100</span></div>
        </div>

        <!-- 网络速度曲线 -->
        <div v-if="data.netSupported" class="ss-card ss-chart-card">
          <div class="ss-chart-head">
            <span><i class="bi bi-activity"></i>{{ t('server.netSpeed') }}</span>
            <span class="ss-legend">
              <i class="ss-dot down"></i>{{ rxNowText }}
              <i class="ss-dot up"></i>{{ txNowText }}
            </span>
          </div>
          <svg class="ss-chart" viewBox="0 0 100 40" preserveAspectRatio="none">
            <line x1="0" y1="10" x2="100" y2="10" class="ss-grid-line" />
            <line x1="0" y1="20" x2="100" y2="20" class="ss-grid-line" />
            <line x1="0" y1="30" x2="100" y2="30" class="ss-grid-line" />
            <polyline v-if="rxPoints" :points="rxPoints" class="ss-line-path rx" vector-effect="non-scaling-stroke" />
            <polyline v-if="txPoints" :points="txPoints" class="ss-line-path tx" vector-effect="non-scaling-stroke" />
          </svg>
          <div class="ss-axis"><span>0</span><span>{{ axisMid }}</span><span>{{ axisMax }}</span></div>
        </div>

        <div v-if="error" class="ss-inline-error">
          <i class="bi bi-exclamation-triangle"></i>{{ error }}
        </div>
      </template>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { getServerStatus, type ServerStatusSnapshot } from '@/service/server-status';

const { t } = useI18n();

const props = defineProps<{
  /** 终端会话 id：切 tab 就换目标，没连上时为空 */
  sessionId: string;
  connectionName?: string;
  /** 悬浮成独立板块：定位与拖动由外层容器接管，面板只管内容 */
  floating?: boolean;
}>();

defineEmits<{ (e: 'close'): void; (e: 'toggle-float'): void }>();

/** 曲线保留的采样点数：2 秒一个点，60 点约 2 分钟 */
const HISTORY_SIZE = 60;
const POLL_INTERVAL = 2000;
/** 网络曲线的纵轴下限，避免空闲时几 KB 的抖动被放大成满屏毛刺 */
const NET_AXIS_MIN_KB = 10;

const data = ref<ServerStatusSnapshot | null>(null);
const loading = ref(false);
const polling = ref(false);
const error = ref('');

const cpuHistory = ref<number[]>([]);
const rxHistory = ref<number[]>([]);
const txHistory = ref<number[]>([]);

let timer: ReturnType<typeof setInterval> | null = null;
/** 面板当前是否在监控：关掉（卸载 / 切走）后任何在途请求的响应都不能再写回数据 */
let alive = false;
/** 请求代号：stop / 重新 start 会推进它，迟到的响应因为对不上号而被丢弃 */
let requestSeq = 0;

const memPercent = computed(() => ratio(data.value?.memUsed, data.value?.memTotal));
const swapPercent = computed(() => ratio(data.value?.swapUsed, data.value?.swapTotal));
const diskPercent = computed(() => ratio(data.value?.diskUsed, data.value?.diskTotal));

/** 服务端识别出的系统家族 → 展示名；服务端加了新家族而这里没跟上时退回原始字符串 */
const osFamilyLabel = computed(() => {
  const family = data.value?.osFamily || '';
  if (!family || family === 'unknown') return '';
  const key = `server.family_${family}`;
  const label = t(key);
  return label === key ? family : label;
});

/** Windows 本机没有分网卡计数，服务端统一报 all，展示时换成整机说法 */
const netIfaceLabel = computed(() => {
  const name = data.value?.netIface || '';
  return name === 'all' ? t('server.netAll') : name;
});

/** 网络纵轴：跟着峰值走，短时间没流量时保持一个下限 */
const netAxisMax = computed(() => {
  const peak = Math.max(...rxHistory.value, ...txHistory.value, 0);
  return Math.max(NET_AXIS_MIN_KB, Math.ceil((peak * 1.2) / 10) * 10);
});

const cpuPoints = computed(() => toPoints(cpuHistory.value, 100, 40));
const cpuArea = computed(() => {
  const points = cpuPoints.value;
  if (!points) return '';
  const list = points.split(' ');
  const firstX = list[0].split(',')[0];
  const lastX = list[list.length - 1].split(',')[0];
  return `${firstX},40 ${points} ${lastX},40`;
});
const rxPoints = computed(() => toPoints(rxHistory.value, netAxisMax.value, 40));
const txPoints = computed(() => toPoints(txHistory.value, netAxisMax.value, 40));

const rxNowText = computed(() => formatNetValue(data.value ? data.value.netRxBps / 1024 : 0));
const txNowText = computed(() => formatNetValue(data.value ? data.value.netTxBps / 1024 : 0));
const axisMid = computed(() => formatNetValue(netAxisMax.value / 2));
const axisMax = computed(() => formatNetValue(netAxisMax.value));

const uptimeText = computed(() => formatUptime(data.value?.uptimeSec || 0));

function ratio(used?: number, total?: number): number {
  if (!used || !total) return 0;
  return Math.min(100, (used / total) * 100);
}

function barWidth(percent: number): string {
  return `${Math.max(0, Math.min(100, percent))}%`;
}

/** 70% 以下走主题绿，85% 以上转红：侧边栏只是扫一眼，颜色比数字快 */
function barColor(percent: number): string {
  if (percent >= 85) return 'var(--danger)';
  if (percent >= 70) return 'var(--warning)';
  return 'var(--success)';
}

function fmtPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

function fmtBytes(bytes: number): string {
  if (!bytes || bytes < 0) return '0';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function fmtSpeed(bps: number): string {
  const kb = bps / 1024;
  if (kb >= 1024) return `${(kb / 1024).toFixed(1)} MB/s`;
  return `${kb >= 100 ? kb.toFixed(0) : kb.toFixed(1)} KB/s`;
}

/** 曲线轴上的数字，单位跟纵轴量级保持一致 */
function formatNetValue(kb: number): string {
  if (kb >= 1024) return `${(kb / 1024).toFixed(1)}M`;
  return `${kb >= 100 ? kb.toFixed(0) : kb.toFixed(1)}`;
}

function formatUptime(seconds: number): string {
  if (!seconds) return '-';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/**
 * 把数值序列压成 SVG 折线点。
 * 点数不足时按已有数量铺满整宽，这样刚打开面板也能看到趋势而不是挤在左边一条竖线。
 */
function toPoints(values: number[], max: number, height: number): string {
  if (!values.length || max <= 0) return '';
  const step = values.length > 1 ? 100 / (values.length - 1) : 0;
  return values
    .map((value, index) => {
      const x = values.length > 1 ? index * step : 0;
      const y = height - Math.min(1, Math.max(0, value / max)) * height;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');
}

function pushHistory(target: typeof cpuHistory, value: number) {
  const next = target.value.slice();
  next.push(value);
  if (next.length > HISTORY_SIZE) next.shift();
  target.value = next;
}

function resetHistory() {
  cpuHistory.value = [];
  rxHistory.value = [];
  txHistory.value = [];
}

async function poll() {
  if (!props.sessionId || polling.value) return;
  const seq = ++requestSeq;
  polling.value = true;
  if (!data.value) loading.value = true;
  try {
    const snapshot = await getServerStatus(props.sessionId);
    // 关面板到响应回来之间的窗口里发出去的那一次：请求已经真的发生了，
    // 但结果不能再写回，否则重新打开会先看到上一轮的旧数据
    if (!alive || seq !== requestSeq) return;
    data.value = snapshot;
    error.value = '';
    // 采不到的指标不参与曲线采样：0 会伪装成「真的很空闲」
    if (snapshot.cpuSupported) pushHistory(cpuHistory, snapshot.cpuPercent);
    if (snapshot.netSupported) {
      pushHistory(rxHistory, snapshot.netRxBps / 1024);
      pushHistory(txHistory, snapshot.netTxBps / 1024);
    }
  } catch (e: any) {
    if (!alive || seq !== requestSeq) return;
    error.value = e?.message || t('server.failed');
  } finally {
    if (alive && seq === requestSeq) {
      polling.value = false;
      loading.value = false;
    }
  }
}

function stop() {
  alive = false;
  // 作废在途请求，并把标志位清干净：重新 start 时不该因为上一个请求没回来而卡住
  requestSeq++;
  polling.value = false;
  loading.value = false;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

function start() {
  stop();
  resetHistory();
  data.value = null;
  error.value = '';
  if (!props.sessionId) return;
  alive = true;
  void poll();
  timer = setInterval(() => {
    // 页面切到后台就别再轮询了，回来时下面会立刻补一次
    if (!document.hidden) void poll();
  }, POLL_INTERVAL);
}

function handleVisibility() {
  if (!document.hidden) void poll();
}

/** 换 tab / 重新连接都会换 sessionId，历史曲线必须跟着清空 */
watch(() => props.sessionId, () => start());

onMounted(() => {
  start();
  document.addEventListener('visibilitychange', handleVisibility);
});

onBeforeUnmount(() => {
  stop();
  document.removeEventListener('visibilitychange', handleVisibility);
});
</script>

<style scoped>
.server-status {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--bg-sidebar);
}

.ss-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
}

.ss-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
}

.ss-title i {
  color: var(--accent);
  font-size: 13px;
}

.ss-actions {
  display: flex;
  gap: 2px;
}

.ss-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  background: none;
  border: none;
  border-radius: 4px;
  color: var(--text-secondary);
  font-size: 11px;
  cursor: pointer;
  transition: all 0.15s;
}

.ss-icon-btn:hover {
  background: rgb(var(--overlay-rgb) / 10%);
  color: var(--text-primary);
}

.ss-icon-btn.spinning i {
  animation: ss-spin 0.9s linear infinite;
}

.ss-icon-btn.active {
  background: rgb(var(--accent-rgb) / 16%);
  color: var(--accent);
}

@keyframes ss-spin {
  to {
    transform: rotate(360deg);
  }
}

.ss-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.ss-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px 8px;
  font-size: 11px;
  color: var(--text-secondary);
  text-align: center;
}

.ss-state-error i {
  font-size: 18px;
  color: var(--warning);
}

.ss-error-text {
  line-height: 1.5;
  word-break: break-word;
}

.ss-retry {
  background: none;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  color: var(--text-secondary);
  font-size: 11px;
  padding: 2px 10px;
  cursor: pointer;
}

.ss-retry:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.ss-card {
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--bg-recess);
  padding: 8px 9px;
}

.ss-host {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 6px;
}

.ss-host i {
  color: var(--accent);
}

.ss-host-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ss-line {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: 10.5px;
  line-height: 1.6;
  color: var(--text-secondary);
}

.ss-line i {
  margin-top: 2px;
  flex-shrink: 0;
  opacity: 0.8;
}

.ss-line span {
  word-break: break-word;
}

/* 自识别出的系统家族徽标 */
.ss-badge {
  flex-shrink: 0;
  font-style: normal;
  font-size: 9.5px;
  line-height: 1.5;
  padding: 0 5px;
  border-radius: 3px;
  color: var(--accent);
  background: rgb(var(--accent-rgb) / 14%);
  border: 1px solid rgb(var(--accent-rgb) / 28%);
}

.ss-badge.family-harmony {
  color: var(--warning);
  background: rgb(var(--warning-rgb) / 12%);
  border-color: rgb(var(--warning-rgb) / 26%);
}

.ss-badge.family-unknown {
  color: var(--text-secondary);
  background: rgb(var(--overlay-rgb) / 10%);
  border-color: rgb(var(--overlay-rgb) / 20%);
}

.ss-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}

.ss-metric {
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--bg-recess);
  padding: 6px 8px;
  min-width: 0;
}

.ss-metric-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
  font-size: 10.5px;
  color: var(--text-secondary);
  margin-bottom: 5px;
}

.ss-metric-head span {
  display: flex;
  align-items: center;
  gap: 4px;
  overflow: hidden;
  white-space: nowrap;
}

.ss-metric-head b {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-primary);
}

.ss-bar {
  height: 4px;
  border-radius: 2px;
  background: rgb(var(--overlay-rgb) / 12%);
  overflow: hidden;
}

.ss-bar i {
  display: block;
  height: 100%;
  border-radius: 2px;
  transition: width 0.4s ease, background 0.3s ease;
}

.ss-metric-foot {
  margin-top: 5px;
  font-size: 10px;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.dim {
  opacity: 0.5;
}

.ss-net-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 10.5px;
  color: var(--text-secondary);
  margin-bottom: 6px;
}

.ss-net-head span {
  display: flex;
  align-items: center;
  gap: 5px;
}

.ss-net-head code {
  font-size: 10px;
  color: var(--text-secondary);
  background: rgb(var(--overlay-rgb) / 10%);
  border-radius: 3px;
  padding: 0 4px;
}

.ss-net-row {
  display: flex;
  gap: 6px;
}

.ss-net-item {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  border-radius: 4px;
  padding: 4px 6px;
  font-size: 10px;
}

.ss-net-item span {
  color: var(--text-secondary);
  flex-shrink: 0;
}

.ss-net-item b {
  font-size: 10.5px;
  margin-left: auto;
  white-space: nowrap;
}

.ss-net-item.down {
  background: rgb(var(--success-rgb) / 10%);
  color: var(--success);
}

.ss-net-item.up {
  background: rgb(var(--warning-rgb) / 10%);
  color: var(--warning);
}

.ss-chart-card {
  padding: 7px 9px 4px;
}

.ss-chart-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 10.5px;
  color: var(--text-secondary);
  margin-bottom: 4px;
}

.ss-chart-head span {
  display: flex;
  align-items: center;
  gap: 5px;
}

.ss-chart-head b {
  color: var(--text-primary);
  font-size: 11px;
}

.ss-legend {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  color: var(--text-secondary);
}

.ss-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  display: inline-block;
}

.ss-dot.down {
  background: var(--success);
}

.ss-dot.up {
  background: var(--warning);
}

.ss-chart {
  width: 100%;
  height: 52px;
  display: block;
}

.ss-grid-line {
  stroke: rgb(var(--overlay-rgb) / 12%);
  stroke-width: 1;
  stroke-dasharray: 2 2;
  vector-effect: non-scaling-stroke;
}

.ss-line-path {
  fill: none;
  stroke-width: 1.5;
  stroke-linejoin: round;
  stroke-linecap: round;
}

.ss-line-path.cpu {
  stroke: var(--accent);
}

.ss-line-path.rx {
  stroke: var(--success);
}

.ss-line-path.tx {
  stroke: var(--warning);
}

.ss-area {
  fill: var(--accent);
  opacity: 0.12;
}

.ss-axis {
  display: flex;
  justify-content: space-between;
  font-size: 9px;
  color: var(--text-secondary);
  opacity: 0.7;
  margin-top: 1px;
}

.ss-inline-error {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 10px;
  color: var(--warning);
  padding: 0 2px 2px;
}
</style>
