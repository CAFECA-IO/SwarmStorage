import { NextResponse } from 'next/server';
import { getLogs } from '@/repositories/ping_store';

export async function GET() {
  const logs = getLogs();
  return NextResponse.json({
    code: 'OK',
    payload: logs,
    count: logs.length
  });
}
