import { memberHeaders } from '@/lib/member';

/**
 * Info: (20261118 - Luphia)
 * 產生 PDF：伺服器能用 Chrome 時回傳 PDF；伺服器沒有 Chrome 時回傳 null (改用瀏覽器列印)
 */
export async function requestPdf(roomId: string, password: string | null, html: string, title: string): Promise<Blob | null> {
  const res = await fetch(`/api/v1/room/${roomId}/pdf`, {
    method: 'POST',
    headers: memberHeaders({ 'Content-Type': 'application/json' }, password),
    body: JSON.stringify({ html, title }),
  });
  if (res.status === 501) return null;
  if (!res.ok || !(res.headers.get('content-type') || '').includes('application/pdf')) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.message || `The PDF could not be created (HTTP ${res.status})`);
  }
  return res.blob();
}

/**
 * Info: (20261118 - Luphia)
 * 瀏覽器列印 (伺服器無法產生 PDF 時)：在隱藏的 iframe 開啟文件並叫出列印視窗，使用者選擇「另存為 PDF」
 * Info: (20261119 - Luphia) 頁面邊界設為 0、改以內距留白，瀏覽器就不會加上日期、網址等頁首頁尾
 */
export function printDocument(html: string, margin: string) {
  const noHeaderFooter = `<style>@page{margin:0}body{padding:${margin}}</style>`;
  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
  iframe.srcdoc = html.replace('</head>', `${noHeaderFooter}</head>`);
  iframe.onload = () => {
    const win = iframe.contentWindow;
    if (!win) return;
    const cleanup = () => setTimeout(() => iframe.remove(), 1000);
    win.addEventListener('afterprint', cleanup, { once: true });
    setTimeout(() => iframe.remove(), 10 * 60 * 1000);
    win.focus();
    win.print();
  };
  document.body.appendChild(iframe);
}

export const pdfNameFor = (filename: string) => filename.replace(/\.(md|markdown)$/i, '') + '.pdf';
