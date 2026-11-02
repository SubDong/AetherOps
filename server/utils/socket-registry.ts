/**
 * 终端 WebSocket 宿主登记表。
 *
 * 为什么要这么一层：wss 是宿主建的（server.js 走 express + ws，vite 中间件走 noServer），
 * 而「紧急断开某个账号」是业务层（handleRoutes）触发的，两边互相 require 都不合适。
 * 于是宿主在握手成功后把 socket 按账号登记到这份共享表里，业务层要踢人时按账号取。
 *
 * 与 data-dir / db pool 同理：esbuild 把同一个模块路径内联成同一份实例，
 * 所以打包态（VSCode runtime / Electron）下宿主与业务层看到的仍是这同一个 Map。
 */

/** 只用到 ws 实例的这几个成员，避免为了类型去 import 整个 ws 包 */
export interface RegistrableSocket {
  readyState?: number;
  close?: (code?: number, reason?: string) => void;
  terminate?: () => void;
}

/** WebSocket.OPEN */
const STATE_OPEN = 1;

const socketsByOwner = new Map<string, Set<RegistrableSocket>>();

export function registerTerminalSocket(ownerId: string, socket: RegistrableSocket): void {
  if (!ownerId) return;
  let set = socketsByOwner.get(ownerId);
  if (!set) {
    set = new Set();
    socketsByOwner.set(ownerId, set);
  }
  set.add(socket);
}

export function unregisterTerminalSocket(ownerId: string, socket: RegistrableSocket): void {
  if (!ownerId) return;
  const set = socketsByOwner.get(ownerId);
  if (!set) return;
  set.delete(socket);
  // 空集合要一起删掉，否则长期累积一堆没有成员的账号键
  if (set.size === 0) socketsByOwner.delete(ownerId);
}

/** 该账号当前还挂着几条终端连接（账号管理页的「在线终端数」用它） */
export function countTerminalSockets(ownerId: string): number {
  const set = socketsByOwner.get(ownerId);
  if (!set) return 0;
  let n = 0;
  for (const socket of set) {
    if (socket.readyState === undefined || socket.readyState === STATE_OPEN) n++;
  }
  return n;
}

/**
 * 关掉某个账号的所有终端 socket。
 * 必须走 close 而不是只删登记：宿主的 ws 'close' 回调里会顺手 closeSession，
 * 让 PTY / SSH 连接与 socket 一起收尾，不留孤儿进程。
 */
export function closeTerminalSockets(ownerId: string, reason = '连接已被关闭'): number {
  const set = socketsByOwner.get(ownerId);
  if (!set || set.size === 0) return 0;
  // 先取快照再遍历：close 会触发宿主回调 → unregister 正在改这个 Set
  const sockets = Array.from(set);
  let closed = 0;
  for (const socket of sockets) {
    try {
      if (socket.close) socket.close(1008, reason);
      else socket.terminate?.();
      closed++;
    } catch (e: any) {
      console.warn(`[SocketRegistry] 关闭 socket 失败: ${e?.message || e}`);
    }
  }
  socketsByOwner.delete(ownerId);
  console.log(`[SocketRegistry] 已关闭 ${closed} 条终端连接（账号 ${ownerId}）`);
  return closed;
}
