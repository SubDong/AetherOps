<template>
  <div class="watch-page">
    <!-- 没有令牌：先贴一枚。这块屏通常不是登录用户在用，所以不给登录入口 -->
    <div v-if="!token" class="watch-gate">
      <div class="gate-card">
        <h1>{{ t('watch.title') }}</h1>
        <p class="gate-hint">{{ t('watch.pasteHint') }}</p>
        <input
          v-model.trim="draft"
          class="gate-input"
          :placeholder="t('watch.pastePlaceholder')"
          @keydown.enter="connect"
        />
        <div v-if="errorText" class="gate-error">{{ errorText }}</div>
        <button class="gate-btn" :disabled="!draft" @click="connect">{{ t('watch.connect') }}</button>
      </div>
    </div>

    <template v-else>
      <header class="watch-head">
        <div class="head-left">
          <span class="brand"><i class="bi bi-display"></i>{{ t('watch.title') }}</span>
          <span v-if="overview" class="viewer">{{ overview.viewer.username }}</span>
        </div>
        <div class="head-right">
          <span v-if="updatedText" class="updated">{{ updatedText }}</span>
          <span class="countdown">{{ t('watch.nextUpdate', { seconds: countdown }) }}</span>
          <button class="head-btn" :disabled="loading" @click="refresh">
            <i class="bi bi-arrow-clockwise"></i>{{ t('watch.refresh') }}
          </button>
          <button class="head-btn" @click="changeToken">{{ t('watch.changeToken') }}</button>
        </div>
      </header>

      <div v-if="errorText" class="watch-error">
        <i class="bi bi-exclamation-triangle"></i>
        <span>{{ errorText }}</span>
        <span v-if="tokenRejected" class="error-hint">{{ t('watch.expiredHint') }}</span>
      </div>

      <div class="watch-body">
        <section class="stats">
          <div class="stat">
            <div class="stat-label">{{ t('watch.openAlerts') }}</div>
            <div class="stat-value danger">{{ counts.open }}</div>
          </div>
          <div class="stat">
            <div class="stat-label">{{ t('watch.ackedAlerts') }}</div>
            <div class="stat-value warn">{{ counts.acked }}</div>
          </div>
          <div class="stat">
            <div class="stat-label">{{ t('watch.resolvedAlerts') }}</div>
            <div class="stat-value ok">{{ counts.resolved }}</div>
          </div>
          <div class="stat">
            <div class="stat-label">{{ t('watch.openIncidents') }}</div>
            <div class="stat-value">{{ overview?.incidents.length ?? 0 }}</div>
          </div>
          <div class="stat">
            <div class="stat-label">{{ t('watch.hosts') }}</div>
            <div class="stat-value">{{ overview?.connections.length ?? 0 }}</div>
          </div>
        </section>

        <section class="panel">
          <h3 class="panel-title"><i class="bi bi-hdd-stack"></i>{{ t('watch.hosts') }}</h3>
          <div v-if="!hostCards.length" class="panel-empty">{{ t('watch.noHosts') }}</div>
          <template v-else>
            <div class="host-grid">
              <div v-for="host in hostCards" :key="host.connectionId" class="host-card" :class="{ offline: host.stale }">
                <div class="host-name">{{ host.name }}</div>
                <div class="host-meta">{{ host.host }}</div>
                <div class="host-metrics">
                  <div class="metric">
                    <span class="metric-label">{{ t('watch.cpu') }}</span>
                    <span class="metric-value" :class="levelClass(host.cpu)">{{ percent(host.cpu) }}</span>
                  </div>
                  <div class="metric">
                    <span class="metric-label">{{ t('watch.mem') }}</span>
                    <span class="metric-value" :class="levelClass(host.mem)">{{ percent(host.mem) }}</span>
                  </div>
                  <div class="metric">
                    <span class="metric-label">{{ t('watch.disk') }}</span>
                    <span class="metric-value" :class="levelClass(host.disk)">{{ percent(host.disk) }}</span>
                  </div>
                </div>
                <div class="host-meta">{{ host.lastText }}</div>
              </div>
            </div>
            <!-- 灰卡片最容易被读成「主机挂了」；这里把「没采到」的原因写出来 -->
            <div v-if="hostHints.length" class="panel-hint">
              <div v-for="hint in hostHints" :key="hint">
                <i class="bi bi-info-circle"></i>
                <span>{{ hint }}</span>
              </div>
            </div>
          </template>
        </section>

        <section class="panel">
          <h3 class="panel-title"><i class="bi bi-bell"></i>{{ t('watch.alerts') }}</h3>
          <div v-if="!overview?.alerts.items.length" class="panel-empty">{{ t('watch.noAlerts') }}</div>
          <table v-else class="alert-table">
            <thead>
              <tr>
                <th>{{ t('watch.level') }}</th>
                <th>{{ t('watch.host') }}</th>
                <th>{{ t('watch.message') }}</th>
                <th>{{ t('watch.occurrences') }}</th>
                <th>{{ t('watch.lastSeen') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="alert in overview.alerts.items" :key="alert.id" :class="'level-' + alert.level">
                <td><span class="level-tag">{{ alert.level }}</span></td>
                <td class="nowrap">{{ connectionName(alert.connectionId) }}</td>
                <td class="message">{{ alert.message }}</td>
                <td class="nowrap">{{ alert.occurrences }}</td>
                <td class="nowrap meta">{{ formatTime(alert.lastSeen) }}</td>
              </tr>
            </tbody>
          </table>
        </section>

        <section class="panel">
          <h3 class="panel-title"><i class="bi bi-diagram-3"></i>{{ t('watch.incidents') }}</h3>
          <div v-if="!overview?.incidents.length" class="panel-empty">{{ t('watch.noIncidents') }}</div>
          <table v-else class="alert-table">
            <thead>
              <tr>
                <th>{{ t('watch.host') }}</th>
                <th>{{ t('watch.message') }}</th>
                <th>{{ t('watch.alertCount') }}</th>
                <th>{{ t('watch.startedAt') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="incident in overview.incidents" :key="incident.id">
                <td class="nowrap">{{ connectionName(incident.connectionId) }}</td>
                <td class="message">{{ incident.title }}</td>
                <td class="nowrap">{{ incident.alertCount }}</td>
                <td class="nowrap meta">{{ formatTime(incident.startedAt) }}</td>
              </tr>
            </tbody>
          </table>
        </section>
      </div>
    </template>
  </div>
</template>

<script lang="ts" setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import {
  WatchTokenError,
  clearWatchToken,
  fetchWatchOverview,
  getWatchToken,
  setWatchToken,
  type WatchOverview,
} from '@/service/watch';

const { t } = useI18n();
const route = useRoute();

/**
 * 大屏的刷新节拍比终端页松得多：数据本身来自分钟桶，告警也只是「有没有新的」。
 * 30 秒足够及时，又不会让一块挂一年的屏每月点掉几十万次请求。
 * 标签页被关掉或切到后台时放慢到 2 分钟——续期不适用于这块屏（令牌不续期），
 * 放慢纯粹是为了不占服务端连接。
 */
const VISIBLE_INTERVAL_MS = 30_000;
const HIDDEN_INTERVAL_MS = 120_000;

const token = ref(getWatchToken());
const draft = ref('');
const overview = ref<WatchOverview | null>(null);
const loading = ref(false);
const errorText = ref('');
const tokenRejected = ref(false);
const now = ref(Date.now());

let timer: ReturnType<typeof setInterval> | null = null;
let ticker: ReturnType<typeof setInterval> | null = null;
let alive = false;

const counts = computed(() => overview.value?.alerts.counts || { open: 0, acked: 0, resolved: 0 });

const updatedText = computed(() =>
  overview.value ? t('watch.updatedAt', { time: new Date(overview.value.generatedAt).toLocaleTimeString() }) : '',
);

/** 距离下一次自动刷新还有几秒，让人知道「这屏是活的」 */
const nextAt = ref(0);
const countdown = computed(() => {
  if (!nextAt.value) return 0;
  return Math.max(0, Math.ceil((nextAt.value - now.value) / 1000));
});

const hostCards = computed(() => {
  const list = overview.value?.connections || [];
  const metrics = new Map((overview.value?.hosts || []).map(host => [host.connectionId, host]));
  const nowMs = now.value;
  return list.map((connection) => {
    const host = metrics.get(connection.id);
    const latest = host?.latest || null;
    // 指标超过 10 分钟没更新 = 采集没走到这台机器（关着、跳过采样或拨号失败）
    const stale = !latest || nowMs - latest.at > 10 * 60_000;
    return {
      connectionId: connection.id,
      name: connection.name || connection.host,
      host: connection.host ? `${connection.host}:${connection.port}` : connection.host,
      cpu: latest?.cpuAvg ?? null,
      mem: latest?.memAvg ?? null,
      disk: latest?.diskAvg ?? null,
      stale,
      // 「有没有采到过」与「老不老」是两件事：提示行只关心前者
      hasData: latest !== null,
      // 连接自己声明了跳过采样，那台主机永远不会上屏，跟全局开关无关
      skipSampling: connection.sampling === 'skip',
      lastText: latest
        ? `${t('watch.samples', { count: latest.samples })} · ${new Date(latest.at).toLocaleTimeString()}`
        : t('watch.noData'),
    };
  });
});

/**
 * 灰卡片的解释。
 *
 * 大屏上「灰 + -」看起来就像主机全挂了，实际常见的是「没人连着这机器，所以没采」。
 * 把口径写在面板里，比让人去翻 config.json 快得多。
 */
const hostHints = computed(() => {
  const hints: string[] = [];
  const cards = hostCards.value;
  if (!overview.value || !cards.length) return hints;

  // 老服务端不返回 sampling，此时不要猜，干脆不提示
  const offlineSampling = overview.value.sampling?.offlineSampling;
  if (offlineSampling === false && cards.some(card => !card.hasData)) hints.push(t('watch.offlineHint'));

  const skipped = cards.filter(card => card.skipSampling).length;
  if (skipped) hints.push(t('watch.skipHint', { count: skipped }));

  // 内存 / 磁盘有值、CPU 空着：不是采挂了，是 CPU 要两次采样求差
  const cpuBlank = cards.some(card => card.hasData && card.cpu === null && (card.mem !== null || card.disk !== null));
  if (cpuBlank) hints.push(t('watch.cpuWarmup'));

  return hints;
});

function percent(value: number | null): string {
  return value === null || value === undefined ? '-' : `${Math.round(value)}%`;
}

function levelClass(value: number | null): string {
  if (value === null || value === undefined) return '';
  if (value >= 90) return 'danger';
  if (value >= 75) return 'warn';
  return 'ok';
}

function connectionName(id: string): string {
  const found = overview.value?.connections.find(item => item.id === id);
  return found?.name || found?.host || id || '-';
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString();
}

async function poll() {
  if (!alive || !token.value) return;
  loading.value = true;
  try {
    overview.value = await fetchWatchOverview(token.value);
    errorText.value = '';
    tokenRejected.value = false;
  } catch (e: any) {
    if (e instanceof WatchTokenError) {
      // 令牌被吊销 / 过期 / 账号被停用：不再重试，停下来等人换令牌
      tokenRejected.value = true;
      errorText.value = t('watch.tokenInvalid');
      stopTimers();
      return;
    }
    errorText.value = t('watch.loadFailed', { msg: e?.message || t('common.failed') });
  } finally {
    loading.value = false;
    scheduleNext();
  }
}

function refresh() {
  if (loading.value) return;
  void poll();
}

function scheduleNext() {
  nextAt.value = Date.now() + (document.hidden ? HIDDEN_INTERVAL_MS : VISIBLE_INTERVAL_MS);
}

function arm() {
  stopTimers();
  if (!alive) return;
  const interval = document.hidden ? HIDDEN_INTERVAL_MS : VISIBLE_INTERVAL_MS;
  scheduleNext();
  timer = setInterval(() => void poll(), interval);
  ticker = setInterval(() => { now.value = Date.now(); }, 1000);
}

function stopTimers() {
  if (timer) { clearInterval(timer); timer = null; }
  if (ticker) { clearInterval(ticker); ticker = null; }
  nextAt.value = 0;
}

function handleVisibility() {
  if (!alive) return;
  arm();
  if (!document.hidden) void poll();
}

function start() {
  if (!token.value) return;
  alive = true;
  overview.value = null;
  errorText.value = '';
  tokenRejected.value = false;
  arm();
  void poll();
}

function connect() {
  const next = draft.value.trim();
  if (!next) return;
  setWatchToken(next);
  token.value = next;
  draft.value = '';
  start();
}

function changeToken() {
  stopTimers();
  alive = false;
  clearWatchToken();
  token.value = '';
  overview.value = null;
  errorText.value = '';
}

onMounted(() => {
  // 首次从「签发表」点过来时令牌在 URL 上：存进本地后立刻从地址栏抹掉，
  // 免得它进浏览历史、Referer 和截图。刷新靠本地那份就够了。
  const fromUrl = typeof route.query.token === 'string' ? route.query.token.trim() : '';
  if (fromUrl) {
    setWatchToken(fromUrl);
    token.value = fromUrl;
    const clean = location.pathname;
    window.history.replaceState({}, '', clean);
  }
  document.addEventListener('visibilitychange', handleVisibility);
  start();
});

onBeforeUnmount(() => {
  alive = false;
  stopTimers();
  document.removeEventListener('visibilitychange', handleVisibility);
});
</script>

<style scoped>
.watch-page {
  min-height: 100vh;
  background: var(--bg-color, #0d1117);
  color: var(--text-primary, #e6edf3);
  font-size: 13px;
}

/* ---------- 贴令牌 ---------- */
.watch-gate {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}

.gate-card {
  width: 420px;
  max-width: 100%;
  padding: 24px;
  border-radius: 10px;
  border: 1px solid var(--border-color, rgba(240, 246, 252, 0.1));
  background: var(--bg-elevated, #161b22);
}

.gate-card h1 {
  margin: 0 0 8px;
  font-size: 18px;
  font-weight: 500;
}

.gate-hint {
  margin: 0 0 14px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-secondary, #8b949e);
}

.gate-input {
  width: 100%;
  padding: 8px;
  font-size: 12px;
  border-radius: 5px;
  border: 1px solid var(--border-strong, rgba(240, 246, 252, 0.14));
  background: var(--bg-input, #0d1117);
  color: var(--text-primary, #e6edf3);
  box-sizing: border-box;
}

.gate-error {
  margin-top: 8px;
  font-size: 12px;
  color: #f85149;
}

.gate-btn {
  width: 100%;
  margin-top: 14px;
  padding: 8px;
  font-size: 13px;
  border-radius: 5px;
  border: 1px solid var(--accent, #58a6ff);
  background: rgb(88 166 255 / 16%);
  color: var(--accent, #58a6ff);
  cursor: pointer;
}

.gate-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* ---------- 头部 ---------- */
.watch-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 20px;
  border-bottom: 1px solid var(--border-color, rgba(240, 246, 252, 0.1));
}

.head-left,
.head-right {
  display: flex;
  align-items: center;
  gap: 12px;
}

.brand {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 15px;
  font-weight: 500;
}

.viewer,
.updated,
.countdown {
  font-size: 11px;
  color: var(--text-secondary, #8b949e);
}

.head-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px;
  font-size: 11px;
  border-radius: 4px;
  border: 1px solid var(--border-color, rgba(240, 246, 252, 0.1));
  background: none;
  color: var(--text-secondary, #8b949e);
  cursor: pointer;
}

.head-btn:hover:not(:disabled) {
  color: var(--accent, #58a6ff);
  border-color: var(--accent, #58a6ff);
}

.watch-error {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 12px 20px 0;
  padding: 8px 10px;
  border-radius: 5px;
  font-size: 12px;
  color: #ffb4ad;
  background: rgba(248, 81, 73, 0.12);
}

.error-hint {
  color: var(--text-secondary, #8b949e);
}

.watch-body {
  padding: 16px 20px 40px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* ---------- 计数 ---------- */
.stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 12px;
}

.stat {
  padding: 12px 14px;
  border-radius: 8px;
  border: 1px solid var(--border-color, rgba(240, 246, 252, 0.1));
  background: var(--bg-elevated, #161b22);
}

.stat-label {
  font-size: 11px;
  color: var(--text-secondary, #8b949e);
}

.stat-value {
  margin-top: 4px;
  font-size: 24px;
  font-variant-numeric: tabular-nums;
}

.stat-value.danger {
  color: #f85149;
}

.stat-value.warn {
  color: #d29922;
}

.stat-value.ok {
  color: #3fb950;
}

/* ---------- 面板 ---------- */
.panel {
  border-radius: 8px;
  border: 1px solid var(--border-color, rgba(240, 246, 252, 0.1));
  background: var(--bg-elevated, #161b22);
  padding: 12px 14px 14px;
}

.panel-title {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 0 10px;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-secondary, #8b949e);
}

.panel-empty {
  padding: 18px 0;
  text-align: center;
  font-size: 12px;
  color: var(--text-secondary, #8b949e);
}

/* ---------- 主机卡片 ---------- */
.host-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 10px;
}

.host-card {
  padding: 10px;
  border-radius: 6px;
  border: 1px solid var(--border-color, rgba(240, 246, 252, 0.1));
  background: var(--bg-input, #0d1117);
}

.host-card.offline {
  opacity: 0.55;
}

/* 灰卡片的说明：压在卡片下面，不抢指标的位置 */
.panel-hint {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 10px;
  font-size: 11px;
  line-height: 1.7;
  color: var(--text-secondary, #8b949e);
}

.panel-hint > div {
  display: flex;
  align-items: flex-start;
  gap: 6px;
}

.host-name {
  font-size: 13px;
}

.host-meta {
  margin-top: 2px;
  font-size: 11px;
  color: var(--text-secondary, #8b949e);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.host-metrics {
  display: flex;
  gap: 14px;
  margin: 8px 0 4px;
}

.metric {
  display: flex;
  flex-direction: column;
}

.metric-label {
  font-size: 10px;
  color: var(--text-secondary, #8b949e);
}

.metric-value {
  font-size: 16px;
  font-variant-numeric: tabular-nums;
}

.metric-value.danger {
  color: #f85149;
}

.metric-value.warn {
  color: #d29922;
}

.metric-value.ok {
  color: #3fb950;
}

/* ---------- 表格 ---------- */
.alert-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.alert-table th {
  text-align: left;
  padding: 6px 8px;
  font-weight: 500;
  font-size: 11px;
  color: var(--text-secondary, #8b949e);
  border-bottom: 1px solid var(--border-color, rgba(240, 246, 252, 0.1));
}

.alert-table td {
  padding: 7px 8px;
  border-bottom: 1px solid rgba(240, 246, 252, 0.06);
}

.alert-table tr.level-critical td {
  background: rgba(248, 81, 73, 0.08);
}

.alert-table tr.level-error td {
  background: rgba(210, 153, 34, 0.06);
}

.level-tag {
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 10px;
  text-transform: uppercase;
  background: rgba(110, 118, 129, 0.2);
}

.level-critical .level-tag {
  color: #f85149;
  background: rgba(248, 81, 73, 0.16);
}

.level-error .level-tag {
  color: #d29922;
  background: rgba(210, 153, 34, 0.16);
}

.message {
  word-break: break-word;
}

.nowrap {
  white-space: nowrap;
}

.meta {
  font-size: 11px;
  color: var(--text-secondary, #8b949e);
}
</style>
