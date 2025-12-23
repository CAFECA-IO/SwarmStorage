
import { NextRequest } from 'next/server';
import { jsonOk, jsonFail } from '@/lib/response';
import { ApiCode } from '@/lib/status';

const IPFS_API_URL = 'http://127.0.0.1:5001';

// Info: (20251022 - Luphia) CORS 標頭
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS', // Info: (20251022 - Luphia) 允許 POST 和 OPTIONS
  'Access-Control-Allow-Headers': 'Content-Type', // Info: (20251022 - Luphia) 允許上傳時的 Content-Type 標頭
};

/**
 * Info: (20251022 - Luphia) 處理 OPTIONS 預檢請求
 */
export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders,
  });
}

/**
 * Info: (20251022 - Luphia) 處理 POST /api/v1/file 請求
 */
export async function POST(request: NextRequest) {
  try {
    // Info: (20251022 - Luphia) 1. 從請求中解析 FormData
    const data = await request.formData();
    const file: File | null = data.get('file') as unknown as File;

    if (!file) {
      return jsonFail(ApiCode.VALIDATION_ERROR, "No file provided", { headers: corsHeaders });
    }

    // Info: (20251022 - Luphia) 2. 建立一個新的 FormData 來轉發到 IPFS
    const ipfsFormData = new FormData();
    ipfsFormData.append('file', file, file.name);

    // Info: (20251022 - Luphia) 3. 將檔案發送到 IPFS 節點的 /api/v0/add
    const ipfsResponse = await fetch(`${IPFS_API_URL}/api/v0/add`, {
      method: 'POST',
      body: ipfsFormData,
    });

    if (!ipfsResponse.ok) {
      const errorText = await ipfsResponse.text();
      console.error('IPFS API Error:', errorText);
      return jsonFail(ApiCode.SERVER_ERROR, `IPFS API Error: ${ipfsResponse.status} ${errorText}`, { headers: corsHeaders });
    }

    // Info: (20251022 - Luphia) 4. 解析 IPFS 的回應
    const result = await ipfsResponse.json();

    // Info: (20251022 - Luphia) 5. 在成功回應中加入 CORS 標頭
    return jsonOk({
      hash: result.Hash,
      name: result.Name,
      size: result.Size
    }, "OK", { headers: corsHeaders });

  } catch (error: unknown) {
    console.error('Upload API error:', error);
    return jsonFail(ApiCode.SERVER_ERROR, (error as Error).message || 'Internal Server Error', { headers: corsHeaders });
  }
}
