import { NextResponse } from 'next/server';
import { ApiCode, HTTP_MAP } from '@/lib/status';
import { name, version } from '@/package';

export const POWERBY = `${name} v${version}`;

export interface IApiResponse<T> {
  powerby: string;
  success: boolean;
  code: ApiCode;
  message: string;
  payload: T | null;
}

export const ok = <T>(payload: T, message = 'OK'): IApiResponse<T> => {
  // Info: (20250926 - Luphia) jsonstringify 無法解析 bigint，這邊做個轉換
  const safePayload = JSON.parse(
    JSON.stringify(payload, (key, value) => (typeof value === 'bigint' ? value.toString() : value))
  );

  return {
    powerby: POWERBY,
    success: true,
    code: ApiCode.OK,
    message,
    payload: safePayload,
  };
};

export const fail = (code: ApiCode, message: string): IApiResponse<null> => ({
  powerby: POWERBY,
  success: false,
  code,
  message,
  payload: null,
});

export const jsonOk = <T>(payload: T, message = 'OK', init?: ResponseInit) =>
  NextResponse.json<IApiResponse<T>>(ok(payload, message), init);

export const jsonFail = (code: ApiCode, message: string, init?: ResponseInit) =>
  NextResponse.json<IApiResponse<null>>(fail(code, message), {
    status: httpStatusOf(code),
    ...init,
  });

function httpStatusOf(code: ApiCode): number {
  // Info: (20261105 - Luphia) 統一使用 status.ts 的對照表 (含 429 RATE_LIMIT、409 CONFLICT)
  return HTTP_MAP[code] ?? 500;
}
