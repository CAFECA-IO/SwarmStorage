import { NextRequest } from 'next/server';
import { jsonOk, jsonFail } from '@/lib/response';
import { ApiCode } from '@/lib/status';
import { readCookie } from '@/lib/auth_session';
import { isSecureRequest } from '@/lib/auth_http';
import { LOGIN_COOKIE, expectedDomain, getCafecaConfig, issueNonce } from '@/lib/cafeca_login';

export const dynamic = 'force-dynamic';

/**
 * Info: (20261108 - Luphia) 處理 POST /api/v1/auth/cafeca/nonce
 * 產生一次性 nonce 並綁定這個瀏覽器 (httpOnly cookie)，5 分鐘內有效
 */
export async function POST(request: NextRequest) {
  const config = getCafecaConfig();
  if (!config) return jsonFail(ApiCode.NOT_FOUND, 'CAFECA sign-in is not enabled');
  const domain = expectedDomain(config, request.headers.get('origin'));
  if (!domain.ok) return jsonFail(ApiCode.FORBIDDEN, domain.message);

  const issued = issueNonce(domain.domain, readCookie(request.headers, LOGIN_COOKIE));
  if (!issued) return jsonFail(ApiCode.RATE_LIMIT, 'Too many sign-in attempts. Try again later.');

  const response = jsonOk({ nonce: issued.nonce, issuedAt: issued.issuedAt, expiresAt: issued.expiresAt, wallet: config.wallet }, 'OK', {
    headers: { 'Cache-Control': 'no-store' },
  });
  response.cookies.set(LOGIN_COOKIE, issued.attemptId, { httpOnly: true, sameSite: 'lax', secure: isSecureRequest(request), path: '/', maxAge: 600 });
  return response;
}
