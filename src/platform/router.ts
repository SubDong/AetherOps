import { createRouter, createWebHistory } from 'vue-router';
import { useTitle } from '@vueuse/core';
import { abortAllPending } from '@/adapter/ajax';
import i18n from '@/utils/i18n';
import { getToken, isAdmin } from '@/utils/auth';

export const router = createRouter({
    history: createWebHistory(import.meta.env.BASE_URL),
    routes: [
        {
            path: '/login',
            name: 'login',
            component: () => import('@/views/login.vue'),
            meta: { titleKey: 'auth.loginTab' }
        },
        {
            path: '/users',
            name: 'users',
            component: () => import('@/views/users.vue'),
            // 管理员专用：账号本身可以管，但看不到别人的数据（隔离不因角色破例）
            meta: { titleKey: 'auth.users', requiresAdmin: true }
        },
        {
            path: '/:pathMatch(.*)*',
            name: 'terminal',
            component: () => import('@/views/index.vue'),
            meta: { titleKey: 'app.title' }
        },
    ],
});

/**
 * 未登录一律回登录页（VSCode / Electron / localhost 不留后门）。
 * 判定只用本地令牌存在性：令牌是否真有效由服务端验，过期后的第一个请求会 401，
 * 再由请求层清登录态重新跳转——这里每次导航都去问一次服务端太贵。
 */
router.beforeEach((to, _from, next) => {
    abortAllPending();
    const hasToken = Boolean(getToken());
    if (!hasToken && to.name !== 'login') {
        next({ name: 'login', query: { redirect: to.fullPath } });
        return;
    }
    if (hasToken && to.name === 'login') {
        next({ path: '/' });
        return;
    }
    if (to.meta?.requiresAdmin && !isAdmin()) {
        next({ path: '/' });
        return;
    }
    next();
});

router.afterEach((to) => {
    if (to.meta?.titleKey) {
        useTitle(i18n.global.t(to.meta.titleKey as string));
    } else if (to.meta?.title) {
        useTitle(to.meta.title as string);
    }
});

export default router;
