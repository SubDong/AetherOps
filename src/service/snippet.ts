import { request } from '@/service/base';

function unwrap<T = any>(res: any): T {
  if (res && typeof res === 'object' && 'ret' in res) {
    if (res.ret !== 0) throw new Error(res.msg || '请求失败');
    return res.data as T;
  }
  return res as T;
}

// ========== 命令片段 ==========

export interface Snippet {
  id: string;
  name: string;
  command: string;
}

export function listSnippets() {
  return request('/api/snippet/list', {}).then(unwrap<Snippet[]>);
}

export function saveSnippet(snippet: Partial<Snippet> & { name: string; command: string }) {
  return request('/api/snippet/save', snippet).then(unwrap<Snippet>);
}

export function deleteSnippet(id: string) {
  return request('/api/snippet/delete', { id }).then(unwrap<boolean>);
}
