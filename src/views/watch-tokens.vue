<template>
  <div class="tokens-page">
    <div class="tokens-header">
      <router-link to="/" class="back-link">
        <i class="bi bi-arrow-left"></i>{{ t('app.title') }}
      </router-link>
      <h2>{{ t('watch.tokensTitle') }}</h2>
    </div>

    <div class="tokens-body">
      <p class="intro">{{ t('watch.tokensHint') }}</p>

      <div v-if="error" class="banner error">
        <span>{{ error }}</span>
      </div>

      <!-- 签发：明文只出现这一次，所以结果块要显眼且不随刷新消失（刷新就真没了） -->
      <div class="card">
        <div class="card-row">
          <input
            v-model.trim="label"
            class="field"
            :placeholder="t('watch.labelPlaceholder')"
            :disabled="!canMonitor || busy"
            @keydown.enter="issue"
          />
          <button class="btn-primary" :disabled="!canMonitor || busy" @click="issue">
            <i class="bi bi-plus-lg"></i>{{ t('watch.create') }}
          </button>
        </div>

        <div v-if="issued" class="issued">
          <div class="issued-title"><i class="bi bi-exclamation-triangle"></i>{{ t('watch.tokenOnce') }}</div>
          <code class="issued-token">{{ issued.token }}</code>
          <div class="issued-actions">
            <button class="btn-ghost" @click="copyText(issued.token)"><i class="bi bi-clipboard"></i>{{ t('watch.copy') }}</button>
            <button class="btn-ghost" @click="openScreen(issued.token)"><i class="bi bi-display"></i>{{ t('watch.openScreen') }}</button>
            <button class="btn-ghost" @click="issued = null">{{ t('common.close') }}</button>
          </div>
          <div class="issued-url">
            <span class="issued-url-label">{{ t('watch.screenUrl') }}</span>
            <code>{{ issuedUrl }}</code>
          </div>
        </div>
      </div>

      <table class="tokens-table">
        <thead>
          <tr>
            <th>{{ t('watch.label') }}</th>
            <th>{{ t('watch.state') }}</th>
            <th>{{ t('watch.createdAt') }}</th>
            <th>{{ t('watch.expiresAt') }}</th>
            <th>{{ t('watch.lastUsedAt') }}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in tokens" :key="item.id">
            <td class="label-cell">{{ item.label || '-' }}</td>
            <td><span class="state" :class="item.state">{{ stateLabel(item.state) }}</span></td>
            <td class="meta">{{ formatTime(item.createdAt) }}</td>
            <td class="meta">{{ formatTime(item.expiresAt) }}</td>
            <td class="meta">{{ item.lastUsedAt ? formatTime(item.lastUsedAt) : t('watch.neverUsed') }}</td>
            <td class="row-actions">
              <button v-if="item.state === 'active'" class="icon-btn danger" @click="revoke(item)">
                <i class="bi bi-slash-circle"></i>{{ t('watch.revoke') }}
              </button>
            </td>
          </tr>
          <tr v-if="!loading && tokens.length === 0">
            <td colspan="6" class="empty">{{ t('watch.empty') }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { toast } from '@/utils/toast';
import { modal } from '@/utils/modal';
import { writeClipboard } from '@/utils/vscode-clipboard';
import { getCurrentUser } from '@/utils/auth';
import {
  createWatchToken,
  listWatchTokens,
  revokeWatchToken,
  watchScreenPath,
  type IssuedWatchToken,
  type WatchTokenBrief,
  type WatchTokenState,
} from '@/service/watch';

const { t } = useI18n();

const tokens = ref<WatchTokenBrief[]>([]);
const loading = ref(false);
const busy = ref(false);
const label = ref('');
const error = ref('');
const issued = ref<IssuedWatchToken | null>(null);

/** 签发要求 monitor 位（服务端还会再校验一次，这里只是别让人白点一次） */
const canMonitor = computed(() => Boolean(getCurrentUser()?.permissions?.monitor));
const issuedUrl = computed(() => (issued.value ? watchScreenPath(issued.value.token) : ''));

function stateLabel(state: WatchTokenState): string {
  if (state === 'active') return t('watch.stateActive');
  if (state === 'revoked') return t('watch.stateRevoked');
  return t('watch.stateExpired');
}

function formatTime(value: string | null): string {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString();
}

async function load() {
  loading.value = true;
  try {
    tokens.value = await listWatchTokens();
    error.value = '';
  } catch (e: any) {
    error.value = t('watch.loadFailed', { msg: e?.msg || e?.message || t('common.failed') });
  } finally {
    loading.value = false;
  }
}

async function issue() {
  if (busy.value || !canMonitor.value) return;
  busy.value = true;
  try {
    const result = await createWatchToken(label.value);
    issued.value = result;
    label.value = '';
    await load();
  } catch (e: any) {
    error.value = t('watch.loadFailed', { msg: e?.msg || e?.message || t('common.failed') });
  } finally {
    busy.value = false;
  }
}

async function revoke(item: WatchTokenBrief) {
  if (!(await modal.confirm(t('watch.revokeConfirm', { label: item.label || '-' })))) return;
  try {
    const ok = await revokeWatchToken(item.id);
    if (!ok) {
      // 已吊销过：不假装成功，直接刷新列表让界面跟库对齐
      toast.success(t('watch.stateRevoked'));
    }
    await load();
  } catch (e: any) {
    error.value = t('watch.loadFailed', { msg: e?.msg || e?.message || t('common.failed') });
  }
}

async function copyText(text: string) {
  try {
    await writeClipboard(text);
    toast.success(t('common.copied'));
  } catch {
    error.value = t('common.failed');
  }
}

function openScreen(token: string) {
  window.open(watchScreenPath(token), '_blank', 'noopener');
}

onMounted(load);
</script>

<style scoped>
.tokens-page {
  min-height: 100vh;
  background: var(--bg-color, #0d1117);
  color: var(--text-primary, #e6edf3);
}

.tokens-header {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 14px 20px;
  border-bottom: 1px solid var(--border-color, rgba(240, 246, 252, 0.1));
}

.tokens-header h2 {
  margin: 0;
  font-size: 16px;
  font-weight: 500;
}

.back-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--text-secondary, #8b949e);
  text-decoration: none;
}

.back-link:hover {
  color: var(--accent, #58a6ff);
}

.tokens-body {
  padding: 16px 20px 40px;
  max-width: 1000px;
}

.intro {
  margin: 0 0 14px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-secondary, #8b949e);
}

.banner {
  display: flex;
  gap: 6px;
  padding: 8px 10px;
  margin-bottom: 12px;
  border-radius: 5px;
  font-size: 12px;
}

.banner.error {
  color: #ffb4ad;
  background: rgba(248, 81, 73, 0.12);
}

.card {
  padding: 12px;
  margin-bottom: 16px;
  border: 1px solid var(--border-color, rgba(240, 246, 252, 0.1));
  border-radius: 8px;
  background: var(--bg-elevated, #161b22);
}

.card-row {
  display: flex;
  gap: 8px;
}

.field {
  flex: 1;
  padding: 6px 8px;
  font-size: 12px;
  border-radius: 4px;
  border: 1px solid var(--border-strong, rgba(240, 246, 252, 0.14));
  background: var(--bg-input, #0d1117);
  color: var(--text-primary, #e6edf3);
}

.btn-primary {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 0 12px;
  font-size: 12px;
  border-radius: 4px;
  border: 1px solid var(--accent, #58a6ff);
  background: rgb(88 166 255 / 16%);
  color: var(--accent, #58a6ff);
  cursor: pointer;
}

.btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.issued {
  margin-top: 12px;
  padding: 10px;
  border-radius: 6px;
  border: 1px dashed rgba(210, 153, 34, 0.55);
  background: rgba(210, 153, 34, 0.08);
}

.issued-title {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: #d29922;
  margin-bottom: 8px;
}

.issued-token {
  display: block;
  padding: 8px;
  border-radius: 4px;
  background: var(--bg-input, #0d1117);
  font-size: 12px;
  word-break: break-all;
  user-select: all;
}

.issued-actions {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}

.issued-url {
  margin-top: 8px;
  font-size: 11px;
  color: var(--text-secondary, #8b949e);
  word-break: break-all;
}

.issued-url-label {
  margin-right: 6px;
}

.btn-ghost {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px;
  font-size: 12px;
  border-radius: 4px;
  border: 1px solid var(--border-color, rgba(240, 246, 252, 0.1));
  background: none;
  color: var(--text-secondary, #8b949e);
  cursor: pointer;
}

.btn-ghost:hover {
  color: var(--accent, #58a6ff);
  border-color: var(--accent, #58a6ff);
}

.tokens-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.tokens-table th {
  text-align: left;
  padding: 7px 8px;
  font-weight: 500;
  font-size: 11px;
  color: var(--text-secondary, #8b949e);
  border-bottom: 1px solid var(--border-color, rgba(240, 246, 252, 0.1));
}

.tokens-table td {
  padding: 8px;
  border-bottom: 1px solid rgba(240, 246, 252, 0.06);
}

.label-cell {
  font-size: 13px;
}

.meta {
  font-size: 11px;
  color: var(--text-secondary, #8b949e);
  white-space: nowrap;
}

.state {
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 11px;
}

.state.active {
  color: #3fb950;
  background: rgba(63, 185, 80, 0.14);
}

.state.revoked {
  color: #f85149;
  background: rgba(248, 81, 73, 0.14);
}

.state.expired {
  color: var(--text-secondary, #8b949e);
  background: rgba(110, 118, 129, 0.16);
}

.row-actions {
  text-align: right;
  white-space: nowrap;
}

.icon-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: none;
  border: 1px solid var(--border-color, rgba(240, 246, 252, 0.1));
  border-radius: 4px;
  color: var(--text-secondary, #8b949e);
  padding: 3px 8px;
  font-size: 11px;
  cursor: pointer;
}

.icon-btn.danger:hover {
  color: #f85149;
  border-color: #f85149;
}

.empty {
  text-align: center;
  padding: 24px;
  color: var(--text-secondary, #8b949e);
}
</style>
