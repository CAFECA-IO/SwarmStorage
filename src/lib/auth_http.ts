import type { NextRequest } from 'next/server';

// Info: (20261108 - Luphia) 是否以 HTTPS 連線 (反向代理後方以 X-Forwarded-Proto 判斷)，決定 cookie 是否加上 Secure
export const isSecureRequest = (request: NextRequest): boolean =>
  request.nextUrl.protocol === 'https:' || request.headers.get('x-forwarded-proto')?.split(',')[0].trim() === 'https';
