<template>
  <div class="users-page">
    <div class="users-header">
      <router-link to="/" class="back-link">
        <i class="bi bi-arrow-left"></i>{{ t('app.title') }}
      </router-link>
      <h2>{{ t('auth.users') }}</h2>
      <button class="btn-new" @click="showCreate = !showCreate">
        <i class="bi bi-person-plus"></i>{{ t('auth.createUser') }}
      </button>
    </div>

    <div class="users-body">
      <div v-if="notice" class="notice" :class="notice.type">
        <span>{{ notice.text }}</span>
        <button class="notice-close" @click="notice = null"><i class="bi bi-x"></i></button>
      </div>

      <!-- 新建账号 -->
      <div v-if="showCreate" class="create-card">
        <div class="create-grid">
          <div>
            <label class="field-label">{{ t('auth.username') }}</label>
            <input v-model.trim="createForm.username" class="field" :placeholder="t('auth.usernameHint')" />
          </div>
          <div>
            <label class="field-label">{{ t('auth.displayName') }}</label>
            <input v-model.trim="createForm.displayName" class="field" />
          </div>
          <div>
            <label class="field-label">{{ t('auth.password') }}</label>
            <input v-model="createForm.password" class="field" :placeholder="t('auth.passwordHint')" />
          </div>
          <div>
            <label class="field-label">{{ t('auth.role') }}</label>
            <select v-model="createForm.role" class="field">
              <option value="user">{{ t('auth.roleUser') }}</option>
              <option value="admin">{{ t('auth.roleAdmin') }}</option>
            </select>
          </div>
        </div>
        <div class="perm-row">
          <label v-for="key in PERMISSION_KEYS" :key="key" class="perm-toggle">
            <input type="checkbox" v-model="createForm.permissions[key]" />
            {{ permLabel(key) }}
          </label>
        </div>
        <div class="d-flex gap-2 mt-2">
          <button class="btn-new" :disabled="busy" @click="submitCreate">{{ t('common.save') }}</button>
          <button class="btn-ghost" @click="showCreate = false">{{ t('common.cancel') }}</button>
        </div>
      </div>

      <!-- 账号列表 -->
      <table class="users-table">
        <thead>
          <tr>
            <th>{{ t('auth.account') }}</th>
            <th>{{ t('auth.role') }}</th>
            <th>{{ t('auth.status') }}</th>
            <th>{{ t('auth.permissions') }}</th>
            <th>{{ t('auth.lastLogin') }}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="user in users" :key="user.id" :class="{ self: user.id === me?.id }">
            <td>
              <div class="user-name">{{ user.displayName || user.username }}</div>
              <div class="user-meta">@{{ user.username }}</div>
            </td>
            <td>
              <!-- 不能改自己：把自己降权后可能再没有管理员可用 -->
              <select
                v-if="user.id !== me?.id"
                class="field compact"
                :value="user.role"
                @change="patchUser(user, { role: ($event.target as HTMLSelectElement).value as UserRole })"
              >
                <option value="user">{{ t('auth.roleUser') }}</option>
                <option value="admin">{{ t('auth.roleAdmin') }}</option>
              </select>
              <span v-else class="user-meta">{{ t('auth.roleAdmin') }}</span>
            </td>
            <td>
              <select
                v-if="user.id !== me?.id"
                class="field compact"
                :class="'status-' + user.status"
                :value="user.status"
                @change="patchUser(user, { status: ($event.target as HTMLSelectElement).value as UserStatus })"
              >
                <option value="pending">{{ t('auth.statusPending') }}</option>
                <option value="active">{{ t('auth.statusActive') }}</option>
                <option value="disabled">{{ t('auth.statusDisabled') }}</option>
              </select>
              <span v-else class="user-meta">{{ t('auth.statusActive') }}</span>
            </td>
            <td>
              <div class="perm-row tight">
                <label v-for="key in PERMISSION_KEYS" :key="key" class="perm-toggle small">
                  <input
                    type="checkbox"
                    :checked="Boolean(user.permissions?.[key])"
                    @change="patchUser(user, { permissions: togglePermission(user, key) })"
                  />
                  {{ permLabel(key) }}
                </label>
              </div>
            </td>
            <td class="user-meta">
              {{ user.lastLoginAt ? formatTime(user.lastLoginAt) : t('auth.neverLogin') }}
            </td>
            <td class="row-actions">
              <!-- 代管入口：审计 / 传输 / 连接 / 紧急断开都在弹层里，不往表格里摊平 -->
              <button
                v-if="user.id !== me?.id"
                class="icon-btn"
                :title="t('member.console')"
                @click="openConsole(user)"
              >
                <i class="bi bi-person-gear"></i>
              </button>
              <button class="icon-btn" :title="t('auth.resetPassword')" @click="resetPassword(user)">
                <i class="bi bi-key"></i>
              </button>
              <button
                v-if="user.id !== me?.id"
                class="icon-btn danger"
                :title="t('common.delete')"
                @click="removeUser(user)"
              >
                <i class="bi bi-trash"></i>
              </button>
            </td>
          </tr>
          <tr v-if="!loading && users.length === 0">
            <td colspan="6" class="empty">{{ t('sidebar.noConnections') }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <MemberConsole
      v-if="consoleUser"
      :user-id="consoleUser.id"
      :username="consoleUser.username"
      @close="consoleUser = null"
    />
  </div>
</template>

<script lang="ts" setup>
import { onMounted, reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { toast } from '@/utils/toast';
import { modal } from '@/utils/modal';
import MemberConsole from '@/components/member-console/index.vue';
import {
  PERMISSION_KEYS,
  adminCreateUser,
  adminDeleteUser,
  adminListUsers,
  adminResetPassword,
  adminUpdateUser,
  getCurrentUser,
  type AuthUser,
  type PermissionKey,
  type UserRole,
  type UserStatus,
} from '@/utils/auth';

const { t } = useI18n();

const users = ref<AuthUser[]>([]);
const loading = ref(false);
const busy = ref(false);
const showCreate = ref(false);
const notice = ref<{ type: 'success' | 'error'; text: string } | null>(null);
const me = ref(getCurrentUser());
/** 当前打开代管弹层的账号；同一时刻只会开一个 */
const consoleUser = ref<AuthUser | null>(null);

const createForm = reactive({
  username: '',
  displayName: '',
  password: '',
  role: 'user' as UserRole,
  permissions: Object.fromEntries(PERMISSION_KEYS.map(k => [k, false])) as Record<string, boolean>,
});

const PERM_LABELS: Record<PermissionKey, string> = {
  terminal: 'permTerminal',
  batch: 'permBatch',
  ai: 'permAi',
  connections: 'permConnections',
  aiConfig: 'permAiConfig',
  files: 'permFiles',
  monitor: 'permMonitor',
  audit: 'permAudit',
  skills: 'permSkills',
  snippets: 'permSnippets',
};

function permLabel(key: PermissionKey): string {
  return t(`auth.${PERM_LABELS[key]}`);
}

function openConsole(user: AuthUser) {
  consoleUser.value = user;
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString();
}

async function load() {
  loading.value = true;
  try {
    users.value = await adminListUsers();
    me.value = getCurrentUser();
  } catch (e: any) {
    notice.value = { type: 'error', text: e?.message || t('common.failed') };
  } finally {
    loading.value = false;
  }
}

function togglePermission(user: AuthUser, key: PermissionKey): Record<string, boolean> {
  const next = { ...(user.permissions || {}) };
  next[key] = !next[key];
  return next;
}

async function patchUser(user: AuthUser, patch: { role?: UserRole; status?: UserStatus; permissions?: Record<string, boolean> }) {
  try {
    const updated = await adminUpdateUser({ id: user.id, ...patch });
    Object.assign(user, updated);
    // 改权限/状态会踢掉对方会话：如果改的是自己，下次请求就 401，提示一句更清楚
    toast.success(t('common.success'));
  } catch (e: any) {
    notice.value = { type: 'error', text: e?.message || t('common.failed') };
    await load();
  }
}

async function submitCreate() {
  if (busy.value) return;
  if (!createForm.username) return;
  busy.value = true;
  try {
    const result = await adminCreateUser({
      username: createForm.username,
      displayName: createForm.displayName || undefined,
      password: createForm.password || undefined,
      role: createForm.role,
      permissions: { ...createForm.permissions },
    });
    notice.value = {
      type: 'success',
      text: `${t('auth.userCreated')}｜${result.user.username}｜${t('auth.password')}: ${result.password}`,
    };
    showCreate.value = false;
    createForm.username = '';
    createForm.displayName = '';
    createForm.password = '';
    for (const key of PERMISSION_KEYS) createForm.permissions[key] = false;
    await load();
  } catch (e: any) {
    notice.value = { type: 'error', text: e?.message || t('common.failed') };
  } finally {
    busy.value = false;
  }
}

async function resetPassword(user: AuthUser) {
  if (!(await modal.confirm(`${t('auth.resetPassword')}？@${user.username}`))) return;
  try {
    const password = await adminResetPassword(user.id);
    notice.value = { type: 'success', text: t('auth.resetDone', { password }) };
  } catch (e: any) {
    notice.value = { type: 'error', text: e?.message || t('common.failed') };
  }
}

async function removeUser(user: AuthUser) {
  if (!(await modal.confirm(t('auth.deleteConfirm', { username: user.username })))) return;
  try {
    await adminDeleteUser(user.id);
    users.value = users.value.filter(u => u.id !== user.id);
  } catch (e: any) {
    notice.value = { type: 'error', text: e?.message || t('common.failed') };
  }
}

onMounted(load);
</script>

<style scoped>
.users-page {
  height: 100vh;
  overflow: auto;
  background: var(--bg-dark, #0d1117);
  color: var(--text-primary, #e6edf3);
}

.users-header {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px 20px;
  border-bottom: 1px solid var(--border-color, rgba(240, 246, 252, 0.1));
}

.users-header h2 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}

.back-link {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--text-secondary, #8b949e);
  text-decoration: none;
}

.back-link:hover {
  color: var(--accent, #58a6ff);
}

.users-body {
  padding: 16px 20px 40px;
  max-width: 1180px;
}

.btn-new {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
  padding: 5px 12px;
  font-size: 12px;
  border-radius: 5px;
  border: 1px solid var(--accent, #58a6ff);
  background: rgba(88, 166, 255, 0.14);
  color: var(--accent, #58a6ff);
  cursor: pointer;
}

.btn-ghost {
  padding: 5px 12px;
  font-size: 12px;
  border-radius: 5px;
  border: 1px solid var(--border-color, rgba(240, 246, 252, 0.1));
  background: none;
  color: var(--text-secondary, #8b949e);
  cursor: pointer;
}

.notice {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 10px;
  margin-bottom: 12px;
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.5;
  word-break: break-all;
}

.notice.success {
  background: rgba(46, 160, 67, 0.12);
  border: 1px solid rgba(46, 160, 67, 0.4);
  color: #7ee787;
}

.notice.error {
  background: rgba(248, 81, 73, 0.12);
  border: 1px solid rgba(248, 81, 73, 0.4);
  color: #ff938c;
}

.notice-close {
  margin-left: auto;
  background: none;
  border: 0;
  color: inherit;
  cursor: pointer;
}

.create-card {
  padding: 14px;
  margin-bottom: 16px;
  border-radius: 8px;
  border: 1px solid var(--border-color, rgba(240, 246, 252, 0.1));
  background: rgba(110, 118, 129, 0.06);
}

.create-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 10px;
}

.field-label {
  display: block;
  margin-bottom: 3px;
  font-size: 11px;
  color: var(--text-secondary, #8b949e);
}

.field {
  width: 100%;
  padding: 5px 7px;
  font-size: 12px;
  border-radius: 4px;
  border: 1px solid var(--border-strong, rgba(240, 246, 252, 0.14));
  background: var(--bg-input, #0d1117);
  color: var(--text-primary, #e6edf3);
}

.field.compact {
  padding: 2px 4px;
  font-size: 11px;
  width: auto;
  min-width: 84px;
}

.perm-row {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 10px;
}

.perm-row.tight {
  gap: 6px;
  margin-top: 0;
}

.perm-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--text-secondary, #8b949e);
  cursor: pointer;
  user-select: none;
}

.perm-toggle.small {
  font-size: 11px;
}

.users-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.users-table th {
  text-align: left;
  padding: 7px 8px;
  font-weight: 500;
  font-size: 11px;
  color: var(--text-secondary, #8b949e);
  border-bottom: 1px solid var(--border-color, rgba(240, 246, 252, 0.1));
}

.users-table td {
  padding: 8px;
  vertical-align: top;
  border-bottom: 1px solid rgba(240, 246, 252, 0.06);
}

.users-table tr.self td {
  background: rgba(88, 166, 255, 0.05);
}

.user-name {
  font-size: 13px;
}

.user-meta {
  font-size: 11px;
  color: var(--text-secondary, #8b949e);
}

.row-actions {
  white-space: nowrap;
}

.icon-btn {
  background: none;
  border: 1px solid var(--border-color, rgba(240, 246, 252, 0.1));
  border-radius: 4px;
  color: var(--text-secondary, #8b949e);
  padding: 2px 6px;
  margin-right: 4px;
  cursor: pointer;
}

.icon-btn:hover {
  color: var(--accent, #58a6ff);
  border-color: var(--accent, #58a6ff);
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

.status-pending {
  border-color: #d29922;
  color: #d29922;
}

.status-disabled {
  border-color: #f85149;
  color: #f85149;
}
</style>
