'use client';

import { useEffect } from 'react';

/**
 * Info: (20261106 - Luphia)
 * 追蹤可視區域 (visualViewport)，寫入 CSS 變數 --vvh (高度) 與 --vv-top (位移)
 * iOS Safari 開啟鍵盤時不會縮小版面 (100dvh 不變) 而是捲動整頁，
 * 以這兩個變數定位全螢幕容器，讓輸入框與送出按鈕維持在鍵盤上方
 */
export default function ViewportTracker() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        root.style.setProperty('--vvh', `${Math.round(vv.height)}px`);
        // Info: (20261106 - Luphia) 使用者手動放大時不跟隨位移，避免畫面跳動
        root.style.setProperty('--vv-top', `${vv.scale > 1.01 ? 0 : Math.max(0, Math.round(vv.offsetTop))}px`);
      });
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      cancelAnimationFrame(frame);
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
      root.style.removeProperty('--vvh');
      root.style.removeProperty('--vv-top');
    };
  }, []);

  return null;
}
