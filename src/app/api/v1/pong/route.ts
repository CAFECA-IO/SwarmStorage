import { getLogs, clearLogs } from '@/repositories/ping_store';
import { jsonOk } from '@/lib/response';

export async function GET() {
  const logs = getLogs();
  return jsonOk(logs);
}

export async function DELETE() {
  clearLogs();
  return jsonOk(null, 'Logs cleared');
}
