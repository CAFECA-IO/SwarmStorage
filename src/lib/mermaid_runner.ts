/**
 * Info: (20261118 - Luphia)
 * mermaid 共用執行器 (瀏覽器端，動態載入)
 * - mermaid 的設定是全域的，且不支援並行繪製：所有繪製排隊執行，每次繪製前套用呼叫端的主題
 * - securityLevel 一律 strict (不執行圖表中的腳本與點擊事件)
 */

type TMermaid = (typeof import('mermaid'))['default'];
export type MermaidConfig = Parameters<TMermaid['initialize']>[0];

export type TMermaidResult = { ok: true; svg: string } | { ok: false; error: string };

let mermaidPromise: Promise<TMermaid> | null = null;
let queue: Promise<unknown> = Promise.resolve();
let counter = 0;

const loadMermaid = (): Promise<TMermaid> => {
  if (!mermaidPromise) mermaidPromise = import('mermaid').then(module => module.default);
  return mermaidPromise;
};

export function renderMermaid(code: string, config: MermaidConfig): Promise<TMermaidResult> {
  const task = queue.then(async (): Promise<TMermaidResult> => {
    const mermaid = await loadMermaid();
    mermaid.initialize({ ...config, startOnLoad: false, securityLevel: 'strict' });
    const id = `dh-mermaid-${Date.now().toString(36)}-${counter++}`;
    try {
      const { svg } = await mermaid.render(id, code);
      return { ok: true, svg };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      // Info: (20261106 - Luphia) 清除 mermaid 失敗時留在主頁面的暫存節點
      document.getElementById(id)?.remove();
      document.getElementById(`d${id}`)?.remove();
    }
  });
  queue = task.catch(() => undefined);
  return task;
}
