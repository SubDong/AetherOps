/**
 * 命令片段服务。
 *
 * 原先片段只存在浏览器 localStorage（aetherops-snippets-v1），换浏览器就丢，
 * VSCode 扩展 / Electron 里也各自一份。现在统一落 MySQL 的 snippets 表，
 * 前端改成走 /api/snippet/*。
 */
import {
  listSnippets, upsertSnippet, deleteSnippetRow, type SnippetRow,
} from '../db/repositories/snippet.repo';

export interface SnippetInput {
  id?: string;
  name?: string;
  command?: string;
}

export class SnippetService {
  async list(ownerId: string): Promise<SnippetRow[]> {
    return listSnippets(ownerId);
  }

  /**
   * 新建或更新。
   * id 缺省时由服务端生成——前端也可以自己生成，但别指望它唯一。
   */
  async save(ownerId: string, input: SnippetInput): Promise<SnippetRow> {
    const name = (input.name || '').trim();
    const command = (input.command || '').trim();
    if (!name) throw new Error('Missing parameter: name');
    if (!command) throw new Error('Missing parameter: command');

    const snippet: SnippetRow = {
      id: (input.id || '').trim() || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      name,
      command,
    };
    await upsertSnippet(ownerId, snippet);
    return snippet;
  }

  async remove(ownerId: string, id: string): Promise<boolean> {
    if (!id) throw new Error('Missing parameter: id');
    const affected = await deleteSnippetRow(ownerId, id);
    return affected > 0;
  }
}
