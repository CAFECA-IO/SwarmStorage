import type { NextRequest } from 'next/server';
import { ApiCode } from '@/lib/status';

// Info: (20261120 - Luphia) 付款 API 共用：對外網址 (Solana Pay 連結) 與錯誤代碼
export const originOf = (request: NextRequest) => {
  const configured = (process.env.PUBLIC_ORIGIN ?? '').split(',')[0]?.trim().replace(/\/+$/, '');
  return configured || request.nextUrl.origin;
};

export const PAY_CODES = {
  invalid: ApiCode.VALIDATION_ERROR,
  forbidden: ApiCode.FORBIDDEN,
  conflict: ApiCode.CONFLICT,
  unavailable: ApiCode.SERVER_ERROR,
} as const;
