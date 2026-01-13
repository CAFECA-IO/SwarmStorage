'use client';

import { useState, useEffect } from 'react';
import { IPingLog } from '@/repositories/ping_store';
import ConfirmDialog from '@/components/confirm_dialog';

export default function PongPage() {
  const [logs, setLogs] = useState<IPingLog[]>([]);
  const [loading, setLoading] = useState(true);

  const [showClearConfirm, setShowClearConfirm] = useState(false);

  const fetchLogs = async () => {
    try {
      const res = await fetch('/api/v1/pong');
      const data = await res.json();
      if (data.code === 'OK') {
        setLogs(data.payload);
      }
    } catch (err) {
      console.error('Failed to fetch logs:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleClearLogs = async () => {
    await fetch('/api/v1/pong', { method: 'DELETE' });
    fetchLogs();
    setShowClearConfirm(false);
  };

  useEffect(() => {
    fetchLogs();
    const interval = setInterval(fetchLogs, 10000); // Info: (20260113 - Luphia) Auto-refresh
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="min-h-screen bg-slate-950 p-6 font-sans text-slate-100">
      <div className="max-w-4xl mx-auto">
        <header className="flex justify-between items-center mb-8 border-b border-white/10 pb-4">
          <div>
            <h1 className="text-3xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-emerald-400 to-cyan-400">
              Ping Pong Logs
            </h1>
            <p className="text-slate-500 text-sm mt-1 font-mono">Live Request Inspector</p>
          </div>
          <div className="flex gap-4 items-center">
            <span className="text-xs font-mono text-slate-400">
              {logs.length} Requests Captured
            </span>
            <button
              onClick={fetchLogs}
              className="bg-white/5 hover:bg-white/10 text-slate-300 px-4 py-2 rounded-lg text-sm font-bold border border-white/10 transition-colors"
            >
              Refresh
            </button>
            <button
              onClick={() => setShowClearConfirm(true)}
              className="bg-red-500/10 hover:bg-red-500/20 text-red-400 px-4 py-2 rounded-lg text-sm font-bold border border-red-500/20 transition-colors"
            >
              Clean
            </button>
          </div>
        </header>

        <ConfirmDialog
          isOpen={showClearConfirm}
          title="Clear Logs"
          description="Are you sure you want to clear all logs? This action cannot be undone."
          confirmText="Clear All"
          cancelText="Cancel"
          type="danger"
          onConfirm={handleClearLogs}
          onCancel={() => setShowClearConfirm(false)}
        />

        {loading && logs.length === 0 ? (
          <div className="text-center text-slate-500 py-12 animate-pulse font-mono">
            Waiting for signals...
          </div>
        ) : logs.length === 0 ? (
          <div className="text-center text-slate-500 py-12 border border-dashed border-white/10 rounded-2xl bg-white/5">
            <p className="mb-2">No requests captured yet.</p>
            <code className="text-xs bg-black/30 px-2 py-1 rounded">
              {`curl -X POST /api/v1/ping -d '{"hello":"world"}'`}
            </code>
          </div>
        ) : (
          <div className="space-y-4">
            {logs.map((log, i) => (
              <div key={i} className="bg-black/20 backdrop-blur-sm border border-white/5 rounded-2xl p-5 shadow-lg overflow-hidden hover:border-white/10 transition-all">
                <div className="flex items-start justify-between mb-4">
                  <div className="flex items-center gap-3">
                    <span className={`px-2 py-1 rounded-md text-xs font-bold font-mono
                      ${log.method === 'GET' ? 'bg-blue-500/20 text-blue-400' :
                        log.method === 'POST' ? 'bg-emerald-500/20 text-emerald-400' :
                          log.method === 'DELETE' ? 'bg-red-500/20 text-red-400' :
                            'bg-purple-500/20 text-purple-400'
                      }`}
                    >
                      {log.method}
                    </span>
                    <span className="font-mono text-sm text-slate-300 break-all">{log.url}</span>
                  </div>
                  <span className="text-xs text-slate-500 font-mono whitespace-nowrap">
                    {new Date(log.timestamp).toLocaleTimeString()}
                  </span>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* Info: (20260113 - Luphia) Headers & Query */}
                  <div className="space-y-4">
                    {Object.keys(log.query).length > 0 && (
                      <div>
                        <h4 className="text-[10px] uppercase tracking-widest text-slate-500 mb-1 font-bold">Query Params</h4>
                        <div className="bg-black/30 rounded-lg p-3 text-xs font-mono text-slate-300 border border-white/5">
                          {Object.entries(log.query).map(([k, v]) => (
                            <div key={k} className="flex gap-2">
                              <span className="text-purple-400">{k}:</span>
                              <span className="break-all">{v}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    <div>
                      <h4 className="text-[10px] uppercase tracking-widest text-slate-500 mb-1 font-bold">Headers</h4>
                      <div className="bg-black/30 rounded-lg p-3 text-xs font-mono text-slate-400 border border-white/5 max-h-40 overflow-y-auto">
                        <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                          {Object.entries(log.headers).map(([k, v]) => (
                            // Info: (20260113 - Luphia) Filter interesting headers
                            !['host', 'connection', 'sec-ch-ua', 'accept-language', 'user-agent'].some(sk => k.includes(sk)) && (
                              <>
                                <span className="text-slate-500 text-right">{k}:</span>
                                <span className="text-slate-300 break-all">{v}</span>
                              </>
                            )
                          ))}
                        </div>
                        <div className="mt-2 pt-2 border-t border-white/5 text-[10px] text-slate-600 italic">
                          (+ standard headers hidden)
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Info: (20260113 - Luphia) Body & Params */}
                  <div className="space-y-4">
                    {log.params && Object.keys(log.params).length > 0 && (
                      <div>
                        <h4 className="text-[10px] uppercase tracking-widest text-slate-500 mb-1 font-bold">Route Params</h4>
                        <pre className="bg-black/30 rounded-lg p-3 text-xs font-mono text-amber-400 border border-white/5 overflow-x-auto">
                          {JSON.stringify(log.params, null, 2)}
                        </pre>
                      </div>
                    )}

                    <div>
                      <h4 className="text-[10px] uppercase tracking-widest text-slate-500 mb-1 font-bold">Body</h4>
                      <div className="bg-black/30 rounded-lg p-3 text-xs font-mono text-green-400 border border-white/5 overflow-x-auto min-h-[100px]">
                        {log.body ? (
                          typeof log.body === 'object' ?
                            <pre>{JSON.stringify(log.body, null, 2)}</pre> :
                            <div className="whitespace-pre-wrap">{String(log.body)}</div>
                        ) : (
                          <span className="text-slate-600 italic">No body content</span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
