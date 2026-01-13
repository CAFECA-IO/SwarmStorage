import { NextRequest, NextResponse } from 'next/server';
import { addLog, IPingLog } from '@/repositories/ping_store';

async function handler(req: NextRequest, { params }: { params: Promise<{ slug?: string[] }> }) {
  const timestamp = new Date().toISOString();
  const method = req.method;
  const url = req.url;

  // Info: (20260113 - Luphia) Extract headers
  const headers: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    headers[key] = value;
  });

  // Info: (20260113 - Luphia) Extract query params
  const query: Record<string, string> = {};
  req.nextUrl.searchParams.forEach((value, key) => {
    query[key] = value;
  });

  // Info: (20260113 - Luphia) Extract route params
  // Info: (20260113 - Luphia) Next.js 15+ params are promises
  const awaitedParams = await params;
  const slug = awaitedParams.slug || null;
  const routeParams = slug ? { slug } : null;

  // Info: (20260113 - Luphia) Extract body
  let body: unknown = null;
  try {
    const contentType = req.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      body = await req.json();
    } else if (contentType.includes('text') || contentType.includes('form')) {
      body = await req.text();
    }
  } catch (e) {
    body = `[Body parse error: ${e}]`;
  }

  const log: IPingLog = {
    method,
    url,
    headers,
    body,
    query,
    params: routeParams,
    timestamp
  };

  addLog(log);

  return NextResponse.json({ code: 'OK', message: 'Pong', timestamp });
}

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const DELETE = handler;
export const PATCH = handler;
export const HEAD = handler;
export const OPTIONS = handler;
