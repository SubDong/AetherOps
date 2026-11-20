import {
  AuthError,
  authenticate,
  bootstrapAdmin,
  changeOwnPassword,
  createUserByAdmin,
  deleteUserByAdmin,
  getUser,
  listAllUsers,
  login,
  register,
  resetUserPassword,
  revokeToken,
  issueWatchToken,
  listWatchTokenBriefs,
  revokeWatchToken,
  tokenTtlSeconds,
  updateUserByAdmin,
  type AdminUpdateInput,
} from '../service/auth.service';
import type { PermissionKey, UserPermissions, UserRole, UserStatus } from '../model/user.entity';
import type { TokenPayload } from '../service/auth.service';
import { openSecretInput, sealSecretOutput } from '../utils/transport-crypto';

export interface AccountRouteResult {
  status: number;
  body: any;
  headers?: Record<string, string>;
}

export interface AccountRouteContext {
  /** 请求里带的 Bearer token（可能为空） */
  token: string;
  /** 已解析的登录态；未登录为 null */
  user: TokenPayload | null;
  /** 客户端 IP，写入 last_login_ip */
  ip: string;
}

/** 不需要登录即可访问的账号相关端点 */
export const PUBLIC_ACCOUNT_PATHS = new Set([
  '/oauth/token',
  '/api/auth/login',
  '/api/auth/register',
  '/oauth/revoke',
]);

/** 统一的未登录响应；error=session_replaced 由「单点登录踢下线」产生 */
const UNAUTHORIZED = { status: 401, body: { error: 'unauthorized', error_description: '未登录或登录已过期' } };

function ok(data: any): AccountRouteResult {
  return { status: 200, body: { ret: 0, msg: 'success', data } };
}

/**
 * 读一个口令字段。
 * 口令一律走密文（见 utils/transport-crypto）：明文到达时按 400 拒绝，
 * 错误码 cipher_required 便于前端区分「口令错了」和「报文没加密」。
 */
function readSecret(body: any, field: string): string {
  try {
    return openSecretInput(body?.[field], field);
  } catch (e: any) {
    throw new AuthError(e?.code || 'cipher_invalid', e?.message || `字段 ${field} 必须以密文传输`, 400);
  }
}

function fail(status: number, code: string, message: string): AccountRouteResult {
  return { status, body: { error: code, error_description: message } };
}

function requireUser(ctx: AccountRouteContext): TokenPayload {
  if (!ctx.user) throw new AuthError('unauthorized', '未登录或登录已过期', 401);
  return ctx.user;
}

function requireAdmin(ctx: AccountRouteContext): TokenPayload {
  const user = requireUser(ctx);
  if (user.role !== 'admin') throw new AuthError('forbidden', '需要管理员权限', 403);
  return user;
}

/** 大屏令牌只服务监控数据，所以签发/查看/吊销都要求 monitor 位 */
function requireMonitor(ctx: AccountRouteContext): TokenPayload {
  const user = requireUser(ctx);
  if (!user.permissions?.monitor) throw new AuthError('forbidden', '当前账号缺少权限：monitor', 403);
  return user;
}

/** OAuth2 令牌端点响应必须禁止缓存，否则中间层可能把令牌缓存下来重放 */
const NO_STORE_HEADERS = { 'Cache-Control': 'no-store', Pragma: 'no-cache' };

/**
 * 处理账号相关路由。
 * 返回 null 表示「不是账号路由」，由调用方回落到业务路由。
 *
 * 不依赖 express：Web 服务器（server.js）与 Vite dev 中间件是两套宿主，
 * 这里用「路径进、结果出」的纯函数形式，两边各转发一次即可。
 */
export async function handleAccountRoutes(
  pathname: string,
  body: any,
  ctx: AccountRouteContext,
): Promise<AccountRouteResult | null> {
  const input = body || {};
  try {
    // 只读监控令牌不是登录会话：改密、签发令牌、用户管理一律不认它。
    // 大屏需要的那点账号信息随 /api/watch/overview 一起回，不必绕进 /api/auth/*。
    if (ctx.user?.kind === 'watch' && !PUBLIC_ACCOUNT_PATHS.has(pathname)) {
      throw new AuthError('forbidden', '只读监控令牌不能访问账号接口', 403);
    }
    switch (pathname) {
      /* ---------------- OAuth2 ---------------- */

      // RFC 6749 §4.3 密码模式。同时兼容 application/json 与表单提交
      case '/oauth/token':
      case '/api/auth/login': {
        const grantType = String(input.grant_type || 'password');
        if (grantType !== 'password') {
          return {
            status: 400,
            headers: NO_STORE_HEADERS,
            body: { error: 'unsupported_grant_type', error_description: '仅支持 grant_type=password' },
          };
        }
        // 口令是密文：抓到请求体也只能看到 ao1.xxx.yyy（见 utils/transport-crypto）
        const issued = await login(String(input.username || ''), readSecret(input, 'password'), ctx.ip);
        return {
          status: 200,
          headers: NO_STORE_HEADERS,
          body: {
            access_token: issued.accessToken,
            token_type: 'Bearer',
            expires_in: issued.expiresIn,
            scope: String(input.scope || 'aetherops'),
            // 非标准附加字段：前端登录后要立刻渲染权限，省一次 /me 请求
            user: issued.user,
          },
        };
      }

      // RFC 7009 令牌撤销
      case '/oauth/revoke': {
        await revokeToken(String(input.token || ctx.token || ''));
        return { status: 200, headers: NO_STORE_HEADERS, body: { ret: 0, msg: 'success' } };
      }

      /* ---------------- 自助 ---------------- */

      case '/api/auth/register': {
        const user = await register(String(input.username || ''), readSecret(input, 'password'), input.displayName);
        return ok({ user, expiresIn: tokenTtlSeconds() });
      }

      case '/api/auth/logout': {
        requireUser(ctx);
        await revokeToken(ctx.token);
        return ok(true);
      }

      case '/api/auth/me': {
        const user = requireUser(ctx);
        // 每次从库里取最新状态：令牌里的是登录时的快照，管理员改了权限会踢人，
        // 但用户主动刷新页面时拿到最新值体验更好。
        const fresh = await getUser(user.userId);
        if (!fresh) return { status: 401, body: { error: 'unauthorized', error_description: '账号已不存在' } };
        return ok(fresh);
      }

      case '/api/auth/changePassword': {
        const user = requireUser(ctx);
        await changeOwnPassword(user.userId, readSecret(input, 'oldPassword'), readSecret(input, 'newPassword'));
        return ok(true);
      }

      /* ---------------- 只读监控令牌（大屏/值班机） ---------------- */

      // 清单：只给自己的，方便「这块屏是哪一枚」与「上次用是什么时候」
      case '/api/auth/listWatchTokens': {
        const user = requireMonitor(ctx);
        return ok(await listWatchTokenBriefs(user.userId));
      }

      // 签发：明文只在这一次响应里，之后库里只有哈希
      case '/api/auth/createWatchToken': {
        const user = requireMonitor(ctx);
        const issued = await issueWatchToken(user.userId, String(input.label || ''));
        return { status: 200, headers: NO_STORE_HEADERS, body: { ret: 0, msg: 'success', data: issued } };
      }

      // 吊销：立即生效（鉴权每次都对库，没有缓存要等）
      case '/api/auth/revokeWatchToken': {
        const user = requireMonitor(ctx);
        const id = Number(input.id);
        if (!Number.isInteger(id) || id <= 0) throw new AuthError('invalid_request', '缺少参数: id');
        return ok(await revokeWatchToken(user.userId, id));
      }

      /* ---------------- 账号管理（仅管理员） ---------------- */

      case '/api/users/list': {
        requireAdmin(ctx);
        return ok(await listAllUsers());
      }

      case '/api/users/create': {
        requireAdmin(ctx);
        const result = await createUserByAdmin({
          username: String(input.username || ''),
          password: readSecret(input, 'password'),
          displayName: input.displayName,
          role: input.role as UserRole | undefined,
          status: input.status as UserStatus | undefined,
          permissions: input.permissions as Partial<UserPermissions> | undefined,
        });
        // 服务端生成的口令也不许明文回包：管理员看到的是明文输入框里的解密结果，
        // 中间链路上只有密文
        return ok({ ...result, password: sealSecretOutput(result.password) });
      }

      case '/api/users/update': {
        const admin = requireAdmin(ctx);
        const targetId = String(input.id || '');
        if (!targetId) throw new AuthError('invalid_request', '缺少参数: id');
        // 自己改自己时不允许顺手改 role/status，避免管理员把自己降权后直接失联
        const patch: AdminUpdateInput = {
          displayName: typeof input.displayName === 'string' ? input.displayName : undefined,
          permissions: input.permissions as Partial<UserPermissions> | undefined,
        };
        if (targetId !== admin.userId) {
          if (input.role !== undefined) patch.role = input.role as UserRole;
          if (input.status !== undefined) patch.status = input.status as UserStatus;
        }
        return ok(await updateUserByAdmin(targetId, patch));
      }

      case '/api/users/resetPassword': {
        requireAdmin(ctx);
        const targetId = String(input.id || '');
        if (!targetId) throw new AuthError('invalid_request', '缺少参数: id');
        return ok({ password: sealSecretOutput(await resetUserPassword(targetId)) });
      }

      case '/api/users/delete': {
        const admin = requireAdmin(ctx);
        const targetId = String(input.id || '');
        if (!targetId) throw new AuthError('invalid_request', '缺少参数: id');
        await deleteUserByAdmin(targetId);
        return ok(true);
      }

      default:
        return null;
    }
  } catch (e: any) {
    if (e instanceof AuthError) {
      const headers = pathname.startsWith('/oauth/') ? NO_STORE_HEADERS : undefined;
      return { status: e.status, body: { error: e.code, error_description: e.message, ret: e.status, msg: e.message }, headers };
    }
    throw e;
  }
}

/** 启动时造初始管理员，密码只打日志一次 */
export async function initAccounts(): Promise<void> {
  const result = await bootstrapAdmin();
  if (result.created) {
    console.log('============================================================');
    console.log(`[Auth] 已创建初始管理员  admin / ${result.password}`);
    console.log('[Auth] 该密码只在本次启动打印一次，登录后请立刻修改');
    console.log('============================================================');
  }
}

export type { PermissionKey };
export { authenticate, PUBLIC_ACCOUNT_PATHS as PUBLIC_PATHS };
