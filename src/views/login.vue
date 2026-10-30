<template>
  <div class="login-page">
    <div class="login-card">
      <div class="login-brand">
        <i class="bi bi-terminal"></i>
        <div>
          <h1>AetherOps</h1>
          <p>{{ tab === 'login' ? t('auth.loginSubtitle') : t('auth.registerSubtitle') }}</p>
        </div>
      </div>

      <div class="login-tabs">
        <button :class="{ active: tab === 'login' }" @click="switchTab('login')">{{ t('auth.loginTab') }}</button>
        <button :class="{ active: tab === 'register' }" @click="switchTab('register')">{{ t('auth.registerTab') }}</button>
      </div>

      <form v-if="tab === 'login'" @submit.prevent="handleLogin">
        <label class="form-label">{{ t('auth.username') }}</label>
        <input v-model.trim="loginForm.username" class="form-control mb-2" autocomplete="username" required />
        <label class="form-label">{{ t('auth.password') }}</label>
        <input v-model="loginForm.password" type="password" class="form-control mb-3" autocomplete="current-password" required />
        <button class="btn btn-primary w-100" type="submit" :disabled="busy">
          <span v-if="busy" class="spinner-border spinner-border-sm me-1"></span>
          {{ t('auth.loginBtn') }}
        </button>
      </form>

      <form v-else @submit.prevent="handleRegister">
        <label class="form-label">{{ t('auth.username') }}</label>
        <input v-model.trim="registerForm.username" class="form-control mb-1" autocomplete="username" required />
        <div class="form-text mb-2">{{ t('auth.usernameHint') }}</div>
        <label class="form-label">{{ t('auth.displayName') }}</label>
        <input v-model.trim="registerForm.displayName" class="form-control mb-2" />
        <label class="form-label">{{ t('auth.password') }}</label>
        <input v-model="registerForm.password" type="password" class="form-control mb-1" autocomplete="new-password" required />
        <div class="form-text mb-2">{{ t('auth.passwordHint') }}</div>
        <label class="form-label">{{ t('auth.confirmPassword') }}</label>
        <input v-model="registerForm.confirmPassword" type="password" class="form-control mb-3" autocomplete="new-password" required />
        <button class="btn btn-primary w-100" type="submit" :disabled="busy">
          <span v-if="busy" class="spinner-border spinner-border-sm me-1"></span>
          {{ t('auth.registerBtn') }}
        </button>
      </form>

      <div v-if="notice" class="login-notice" :class="notice.type">{{ notice.text }}</div>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { reactive, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import { login, register } from '@/utils/auth';

const { t } = useI18n();
const route = useRoute();
const router = useRouter();

const tab = ref<'login' | 'register'>('login');
const busy = ref(false);
const notice = ref<{ type: 'error' | 'success'; text: string } | null>(null);

const loginForm = reactive({ username: '', password: '' });
const registerForm = reactive({ username: '', displayName: '', password: '', confirmPassword: '' });

function switchTab(next: 'login' | 'register') {
  tab.value = next;
  notice.value = null;
}

/** 登录成功后回到被判 401 时所在页面，而不是一律回首页 */
function redirectTarget(): string {
  const raw = route.query.redirect;
  const target = typeof raw === 'string' ? raw : '';
  // 只接受站内路径：带上 //host 或协议头的会被当成外链
  if (!target || !target.startsWith('/') || target.startsWith('//')) return '/';
  return target;
}

async function handleLogin() {
  if (busy.value) return;
  busy.value = true;
  notice.value = null;
  try {
    await login(loginForm.username, loginForm.password);
    router.replace(redirectTarget());
  } catch (e: any) {
    notice.value = { type: 'error', text: e?.message || '登录失败' };
  } finally {
    busy.value = false;
  }
}

async function handleRegister() {
  if (busy.value) return;
  if (registerForm.password !== registerForm.confirmPassword) {
    notice.value = { type: 'error', text: t('auth.passwordMismatch') };
    return;
  }
  busy.value = true;
  notice.value = null;
  try {
    await register(registerForm.username, registerForm.password, registerForm.displayName || undefined);
    // 注册拿不到令牌（后端不签发），所以这里只是把表单切回登录并提示待授权
    notice.value = { type: 'success', text: t('auth.registered') };
    loginForm.username = registerForm.username;
    loginForm.password = '';
    tab.value = 'login';
  } catch (e: any) {
    notice.value = { type: 'error', text: e?.message || '注册失败' };
  } finally {
    busy.value = false;
  }
}
</script>

<style scoped>
.login-page {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: radial-gradient(circle at 20% 20%, #1b2a3d 0%, #0d1117 55%, #05070a 100%);
  color: #e6edf3;
  overflow: auto;
}

.login-card {
  width: 100%;
  max-width: 380px;
  padding: 28px 26px 22px;
  border-radius: 14px;
  background: rgba(22, 27, 34, 0.92);
  border: 1px solid rgba(240, 246, 252, 0.1);
  box-shadow: 0 18px 50px rgba(0, 0, 0, 0.55);
}

.login-brand {
  display: flex;
  gap: 12px;
  align-items: center;
  margin-bottom: 20px;
}

.login-brand i {
  font-size: 30px;
  color: #58a6ff;
}

.login-brand h1 {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  letter-spacing: 0.4px;
}

.login-brand p {
  margin: 2px 0 0;
  font-size: 12px;
  color: #8b949e;
  line-height: 1.45;
}

.login-tabs {
  display: flex;
  gap: 6px;
  padding: 3px;
  border-radius: 8px;
  background: rgba(110, 118, 129, 0.12);
  margin-bottom: 18px;
}

.login-tabs button {
  flex: 1;
  padding: 7px 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: #8b949e;
  font-size: 13px;
  cursor: pointer;
}

.login-tabs button.active {
  background: rgba(88, 166, 255, 0.16);
  color: #e6edf3;
}

.form-label {
  font-size: 12px;
  color: #8b949e;
  margin-bottom: 4px;
}

.form-control {
  background: #0d1117;
  border: 1px solid rgba(240, 246, 252, 0.14);
  color: #e6edf3;
}

.form-control:focus {
  background: #0d1117;
  border-color: #58a6ff;
  color: #e6edf3;
  box-shadow: 0 0 0 3px rgba(88, 166, 255, 0.18);
}

.form-text {
  font-size: 11px;
  color: #6e7681;
}

.login-notice {
  margin-top: 14px;
  padding: 9px 11px;
  border-radius: 7px;
  font-size: 12px;
  line-height: 1.5;
}

.login-notice.error {
  background: rgba(248, 81, 73, 0.12);
  border: 1px solid rgba(248, 81, 73, 0.4);
  color: #ff938c;
}

.login-notice.success {
  background: rgba(46, 160, 67, 0.12);
  border: 1px solid rgba(46, 160, 67, 0.4);
  color: #7ee787;
}
</style>
