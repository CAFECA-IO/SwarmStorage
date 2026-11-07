import { NextRequest } from 'next/server';
import { jsonOk, jsonFail } from '@/lib/response';
import { ApiCode } from '@/lib/status';
import { SESSION_COOKIE, accountMemberHash, encodeSession, readCookie, sessionCookieOptions } from '@/lib/auth_session';
import { isSecureRequest } from '@/lib/auth_http';
import { LOGIN_COOKIE, expectedDomain, getCafecaConfig, takeNonce, verifyCafecaLogin } from '@/lib/cafeca_login';
import { hashMemberKey } from '@/lib/room_access';
import { mergeMemberIntoAccount } from '@/lib/room_store';
import type { SignInResponse } from '@/lib/cafeca/verify';

export const dynamic = 'force-dynamic';

/**
 * Info: (20261108 - Luphia) 處理 POST /api/v1/auth/cafeca/login
 * 驗證 CAFECA 錢包交回的登入結果 (body 為錢包回應原文)，成功後：
 * - 建立 session cookie (帳戶地址 + 代稱)
 * - 把這台瀏覽器 (x-member-key) 匿名建立的房間與檔案併入帳戶
 */
export async function POST(request: NextRequest) {
  const config = getCafecaConfig();
  if (!config) return jsonFail(ApiCode.NOT_FOUND, 'CAFECA sign-in is not enabled');

  // Info: (20261108 - Luphia) 不論成功與否，nonce 都在驗證前作廢
  const pending = takeNonce(readCookie(request.headers, LOGIN_COOKIE));
  const domain = expectedDomain(config, request.headers.get('origin'));
  if (!domain.ok) return jsonFail(ApiCode.FORBIDDEN, domain.message);
  if (!pending || pending.domain !== domain.domain) return jsonFail(ApiCode.UNAUTHORIZED, 'Sign-in expired. Please try again.');

  let body: SignInResponse;
  try {
    body = (await request.json()) as SignInResponse;
  } catch {
    return jsonFail(ApiCode.VALIDATION_ERROR, 'Invalid JSON body');
  }

  let user: { account: string; handle: string | null };
  try {
    user = await verifyCafecaLogin(config, body, domain.domain, pending.nonce);
  } catch (error) {
    console.warn('[Auth] CAFECA sign-in rejected:', error instanceof Error ? error.message : error);
    return jsonFail(ApiCode.UNAUTHORIZED, 'Sign-in could not be verified. Please try again.');
  }

  const keyHash = hashMemberKey(request.headers.get('x-member-key'));
  const merged = keyHash ? await mergeMemberIntoAccount(keyHash, accountMemberHash(user.account), user.handle) : { rooms: 0, files: 0 };

  const session = encodeSession(user.account, user.handle);
  const response = jsonOk({ account: user.account, handle: user.handle, merged }, 'Signed in', { headers: { 'Cache-Control': 'no-store' } });
  response.cookies.set(SESSION_COOKIE, session.value, sessionCookieOptions(isSecureRequest(request), session.maxAge));
  response.cookies.set(LOGIN_COOKIE, '', { path: '/', maxAge: 0 });
  return response;
}
