export interface IPingLog {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  query: Record<string, string>;
  params: Record<string, string | string[]> | null;
  timestamp: string;
}

/**
 * Info: (20260113 - Luphia) Global variable to store logs (cleared on server restart)
 * In Next.js dev mode, this might reset often.
 * For a production-like persistent behavior across requests (but not restarts), looking for a global singleton pattern or just module level var is usually fine for "demo" purposes.
 * However, in dev, module reloading clears this.
 */
const globalForLogs = global as unknown as { requestLogs: IPingLog[] };

export const requestLogs = globalForLogs.requestLogs || [];

if (process.env.NODE_ENV !== 'production') globalForLogs.requestLogs = requestLogs;

export const addLog = (log: IPingLog) => {
  requestLogs.unshift(log); // Info: (20260113 - Luphia) Add to beginning
  // Info: (20260113 - Luphia) Limit to last 100 logs to prevent memory leak
  if (requestLogs.length > 100) {
    requestLogs.pop();
  }
};

export const getLogs = () => {
  return requestLogs;
};
