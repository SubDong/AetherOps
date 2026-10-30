<template>
  <div class="account-menu">
    <button class="account-trigger" :title="t('auth.account')" @click="toggle">
      <i class="bi bi-person-circle"></i>
      <span class="account-name text-truncate">{{ user?.displayName || user?.username || '-' }}</span>
    </button>

    <div v-if="open" class="account-panel" @click.stop>
      <div class="account-head">
        <div class="account-display">{{ user?.displayName || user?.username }}</div>
        <div class="account-meta">
          @{{ user?.username }}
          <span class="badge-role">{{ user?.role === 'admin' ? t('auth.roleAdmin') : t('auth.roleUser') }}</span>
        </div>
      </div>

      <div v-if="pending" class="account-pending">
        <i class="bi bi-exclamation-triangle"></i>{{ t('auth.pendingBanner') }}
      </div>

      <button v-if="!changing" class="account-item" @click="startChangePassword">
        <i class="bi bi-key"></i>{{ t('auth.changePassword') }}
      </button>

      <form v-else class="account-password" @submit.prevent="submitPassword">
        <input v-model="oldPassword" type="password" class="account-input" :placeholder="t('auth.oldPassword')" autocomplete="current-password" />
        <input v-model="newPassword" type="password" class="account-input" :placeholder="t('auth.newPassword')" autocomplete="new-password" />
        <div v-if="passwordError" class="account-error">{{ passwordError }}</div>
        <div class="d-flex gap-1">
          <button type="submit" class="account-btn" :disabled="passwordBusy">{{ t('common.save') }}</button>
          <button type="button" class="account-btn ghost" @click="cancelChangePassword">{{ t('common.cancel') }}</button>
        </div>
      </form>

      <router-link v-if="admin" class="account-item" to="/users" @click="open = false">
        <i class="bi bi-people"></i>{{ t('auth.users') }}
      </router-link>

      <button class="account-item danger" @click="handleLogout">
        <i class="bi bi-box-arrow-right"></i>{{ t('auth.logout') }}
      </button>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { toast } from '@/utils/toast';
import { modal } from '@/utils/modal';
import { changePassword, clearAuth, getCurrentUser, logout, redirectToLogin } from '@/utils/auth';

const { t } = useI18n();

const open = ref(false);
const changing = ref(false);
const oldPassword = ref('');
const newPassword = ref('');
const passwordError = ref('');
const passwordBusy = ref(false);

/** 登录态只在登录/刷新时写入 localStorage，这里读一次就够（改密码后会整页重登） */
const user = ref(getCurrentUser());
const admin = computed(() => user.value?.role === 'admin');
const pending = computed(() => user.value?.status === 'pending');

function toggle() {
  open.value = !open.value;
  if (!open.value) cancelChangePassword();
}

function closeOnOutside(event: MouseEvent) {
  const target = event.target as HTMLElement | null;
  if (target && !target.closest('.account-menu')) open.value = false;
}

function startChangePassword() {
  changing.value = true;
  passwordError.value = '';
}

function cancelChangePassword() {
  changing.value = false;
  oldPassword.value = '';
  newPassword.value = '';
  passwordError.value = '';
}

async function submitPassword() {
  if (passwordBusy.value) return;
  passwordBusy.value = true;
  passwordError.value = '';
  try {
    await changePassword(oldPassword.value, newPassword.value);
    // 服务端改密后会吊销令牌，本地必须跟着清，否则界面还在「已登录」但每个请求都 401
    clearAuth();
    toast.success(t('auth.passwordChanged'));
    redirectToLogin();
  } catch (e: any) {
    passwordError.value = e?.message || t('common.failed');
  } finally {
    passwordBusy.value = false;
  }
}

async function handleLogout() {
  open.value = false;
  if (!(await modal.confirm(t('auth.logoutConfirm')))) return;
  await logout();
}

onMounted(() => document.addEventListener('click', closeOnOutside));
onBeforeUnmount(() => document.removeEventListener('click', closeOnOutside));
</script>

<style scoped>
.account-menu {
  position: relative;
}

.account-trigger {
  display: flex;
  align-items: center;
  gap: 5px;
  max-width: 130px;
  background: none;
  border: 1px solid var(--border-color);
  color: var(--text-secondary);
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 11px;
  cursor: pointer;
  line-height: 1.2;
}

.account-trigger:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.account-name {
  max-width: 88px;
}

.account-panel {
  position: absolute;
  right: 0;
  bottom: calc(100% + 6px);
  width: 208px;
  padding: 8px;
  border-radius: 8px;
  background: var(--bg-elevated, #161b22);
  border: 1px solid var(--border-strong, rgba(240, 246, 252, 0.14));
  box-shadow: 0 12px 28px rgba(0, 0, 0, 0.45);
  z-index: 60;
}

.account-head {
  padding: 2px 4px 8px;
  border-bottom: 1px solid var(--border-color);
  margin-bottom: 6px;
}

.account-display {
  font-size: 13px;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.account-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-secondary);
}

.badge-role {
  padding: 0 5px;
  border-radius: 3px;
  background: rgb(var(--accent-rgb, 88 166 255) / 16%);
  color: var(--accent);
}

.account-pending {
  display: flex;
  gap: 5px;
  padding: 6px;
  margin-bottom: 6px;
  border-radius: 5px;
  font-size: 11px;
  line-height: 1.4;
  color: #ffb4ad;
  background: rgba(248, 81, 73, 0.12);
}

.account-item {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px;
  border: 0;
  border-radius: 5px;
  background: none;
  color: var(--text-primary);
  font-size: 12px;
  text-decoration: none;
  cursor: pointer;
}

.account-item:hover {
  background: rgb(var(--overlay-rgb, 110 118 129) / 14%);
}

.account-item.danger {
  color: var(--danger, #f85149);
}

.account-password {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 4px 2px 6px;
}

.account-input {
  width: 100%;
  padding: 4px 6px;
  font-size: 12px;
  border-radius: 4px;
  border: 1px solid var(--border-strong, rgba(240, 246, 252, 0.14));
  background: var(--bg-input, #0d1117);
  color: var(--text-primary);
}

.account-error {
  font-size: 11px;
  color: var(--danger, #f85149);
}

.account-btn {
  flex: 1;
  padding: 4px 0;
  font-size: 12px;
  border-radius: 4px;
  border: 1px solid var(--accent);
  background: rgb(var(--accent-rgb, 88 166 255) / 16%);
  color: var(--accent);
  cursor: pointer;
}

.account-btn.ghost {
  border-color: var(--border-color);
  background: none;
  color: var(--text-secondary);
}
</style>
