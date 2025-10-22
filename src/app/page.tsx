// Info: (20251022 - Luphia) 用於測試我們的 IPFS 上傳和下載 API 路由的簡單頁面
"use client";

import { useState, FormEvent, ChangeEvent } from 'react';

/**
 * Info: (20251022 - Luphia) file API JSON 格式
 * {
 *   powerby: POWER_BY_STRING,
 *   success: true,
 *   code: "OK",
 *   message: "OK",
 *   payload: {
 *     cid: result.Hash,
 *     name: result.Name,
 *     size: result.Size
 *   }
 * }
 */
export default function ApiTestPage() {
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState<boolean>(false);
  const [error, setError] = useState<string>('');
  const [uploadResult, setUploadResult] = useState<{ cid: string, name: string } | null>(null);

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      setFile(e.target.files[0]);
      setUploadResult(null);
      setError('');
    }
  };

  // Info: (20251022 - Luphia) 處理上傳
  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!file) return;

    setUploading(true);
    setError('');
    setUploadResult(null);

    const formData = new FormData();
    formData.append('file', file);

    try {
      // Info: (20251022 - Luphia) 呼叫檔案上傳 API
      const response = await fetch('/api/v1/file', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        const errData = await response.json();
        throw new Error(errData.error || 'Upload failed');
      }

      const responseData = await response.json();
      const result = {
        cid: responseData.payload.hash,
        name: responseData.payload.name
      };
      setUploadResult(result);

    } catch (err: unknown) {
      setError((err as Error).message);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div style={{ padding: '20px', fontFamily: 'Arial, sans-serif' }}>
      <h1>測試 IPFS API 路由</h1>

      <h2>1. 上傳檔案</h2>
      <form onSubmit={handleSubmit}>
        <input
          type="file"
          onChange={handleFileChange}
          disabled={uploading}
        />
        <button
          type="submit"
          disabled={uploading || !file}
          style={{ marginLeft: '10px' }}
        >
          {uploading ? '上傳中...' : '上傳'}
        </button>
      </form>

      {error && (
        <div style={{ color: 'red', marginTop: '10px' }}>
          <strong>錯誤:</strong> {error}
        </div>
      )}

      {uploadResult && (
        <div style={{ marginTop: '20px', background: '#f0f0f0', padding: '15px' }}>
          <h3>上傳成功！</h3>
          <p><strong>檔案名稱:</strong> {uploadResult.name}</p>
          <p><strong>CID:</strong> {uploadResult.cid}</p>

          <hr />

          {/**
            * Info: (20251022 - Luphia)
            * 使用我們的下載 API
            * 上傳至 IPFS 後檔名會變成 hash 值，故傳遞 ?filename=... 來指定下載的檔名
          */}
          <a
            href={`/api/v1/file/${uploadResult.cid}?filename=${encodeURIComponent(uploadResult.name)}`}
            download // Info: (20251022 - Luphia) 雖然 API 會設定 header，但在 <a> 標籤上加上 download 屬性是個好習慣
            style={{
              display: 'inline-block',
              padding: '10px 15px',
              background: 'blue',
              color: 'white',
              textDecoration: 'none',
              borderRadius: '5px'
            }}
          >
            點此下載檔案
          </a>
        </div>
      )}
    </div>
  );
}
