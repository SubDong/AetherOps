<template>
  <!-- 终端页保活：去账号管理等路由再回来时不能销毁 xterm 与 WebSocket，
       否则已连着的会话会被全部重连。只缓存终端页，登录页/账号管理页照常销毁 -->
  <router-view v-slot="{ Component }">
    <keep-alive :include="['TerminalView']">
      <component :is="Component" />
    </keep-alive>
  </router-view>
</template>

<script lang="ts" setup>
import { onMounted, onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';
import { publish } from '@/base/eventBus';
import { toast } from '@/utils/toast';

const { t } = useI18n();

let unsubscribeUpdate: (() => void) | null = null;
let unsubscribeMenu: (() => void) | null = null;

onMounted(() => {
  // 仅在 Electron 环境中监听更新事件
  if (!window.electronAPI?.updater) return;

  unsubscribeUpdate = window.electronAPI.updater.onEvent((msg: any) => {
    const { event, data } = msg;
    if (event === 'available' && data?.version) {
      const version = data.version;
      const downloadUrl = data.downloadUrl || 'https://github.com/SubDong/AetherOps/releases/latest';
      toast.info(
        t('update.available', { version }),
        t('update.newVersion'),
        8000
      );
    }
  });

  // 监听菜单操作
  unsubscribeMenu = window.electronAPI.updater.onMenuAction((action: string) => {
    if (action === 'check-update') {
      window.electronAPI?.updater?.checkForUpdates();
    } else if (action === 'new-connection') {
      publish('MENU_NEW_CONNECTION');
    }
  });
});

onBeforeUnmount(() => {
  unsubscribeUpdate?.();
  unsubscribeMenu?.();
});
</script>

<style>
html, body, #app {
  margin: 0;
  padding: 0;
  height: 100%;
  overflow: hidden;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}
</style>
