import Axios from 'axios';
import type { AxiosRequestConfig } from 'axios';
import { authHeaders, redirectToLogin } from '@/utils/auth';

const axios = Axios.create();

// 令牌统一在这里注入：每个业务 service 各自加头，漏一个就会在「偶发 401」上浪费半天
axios.interceptors.request.use((cfg) => {
    for (const [key, value] of Object.entries(authHeaders())) cfg.headers.set(key, value);
    return cfg;
});

axios.interceptors.response.use(
    (res) => res,
    (error) => {
        // 401 = 令牌过期或被另一处登录顶掉：清掉本地登录态回登录页。
        // 不这么做的表现是页面停在一堆「请求失败」里，用户不知道要重新登录。
        if (error?.response?.status === 401) redirectToLogin();
        return Promise.reject(error);
    },
);

export async function request(url: string, data?: any, option?: AxiosRequestConfig) {
    option = { method: 'POST', withCredentials: true, ...option, headers: { ...(option?.headers || {}) } };
    let res;
    if (option.method === 'GET' || option.method === 'get') {
        res = await axios.get(url, { ...option, params: { ...(option.params || {}), ...data || {} } });
    } else {
        res = await axios.post(url, data, option);
    }
    return res;
}

export async function post(url: string, data?: any, option?: AxiosRequestConfig) {
    return request(url, data, { method: 'post', ...option });
}

export async function get(url: string, data?: any, option?: AxiosRequestConfig) {
    return request(url, data, { method: 'get', ...option });
}
