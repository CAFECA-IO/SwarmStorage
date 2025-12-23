
import { NextRequest } from 'next/server';
import { jsonFail } from '@/lib/response';
import { ApiCode } from '@/lib/status';

const IPFS_API_URL = 'http://127.0.0.1:5001';

// Info: (20251022 - Luphia) CORS 標頭
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS', // Info: (20251022 - Luphia) 允許 GET 和 OPTIONS
  'Access-Control-Allow-Headers': 'Content-Type',
};

/**
 * Info: (20251022 - Luphia) 處理 OPTIONS 預檢驗請求
 */
export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders,
  });
}

/**
 * Info: (20251022 - Luphia) 處理 GET /api/v1/file/[file_id]
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ file_id: string }> }
) {
  try {
    const params = await context.params;
    const cid = params.file_id;

    if (!cid) {
      return jsonFail(ApiCode.VALIDATION_ERROR, "File ID is required", { headers: corsHeaders });
    }

    const apiUrl = `${IPFS_API_URL}/api/v0/cat?arg=${cid}`;
    const ipfsResponse = await fetch(apiUrl, {
      method: 'POST',
    });

    if (!ipfsResponse.ok) {
      // Info: (20251022 - Luphia) 處理 IPFS API 錯誤回應（可能是檔案不存在或服務異常）
      const errorText = await ipfsResponse.text();
      // For detailed details regarding IPFS error, we might log it or include it but jsonFail only takes message.
      // We can append details to message or strictly follow IApiResponse interface which has message.
      // Ideally payload could carry details but jsonFail payload is null. 
      // We will put details in message for now or just log.
      return jsonFail(ApiCode.NOT_FOUND, `File not found on IPFS or API error: ${errorText}`, { headers: corsHeaders });
    }

    const bodyStream = ipfsResponse.body;

    // Info: (20251022 - Luphia) 建立新的 Headers 物件並加入所有 CORS 標頭
    const headers = new Headers();
    headers.set('Access-Control-Allow-Origin', corsHeaders['Access-Control-Allow-Origin']);
    headers.set('Access-Control-Allow-Methods', corsHeaders['Access-Control-Allow-Methods']);
    headers.set('Access-Control-Allow-Headers', corsHeaders['Access-Control-Allow-Headers']);

    /**
     * Info: (20251022 - Luphia) 暴露 Content-Disposition
     * 允許瀏覽器端的 JavaScript 讀取 'Content-Disposition' 標頭
     */
    headers.set('Access-Control-Expose-Headers', 'Content-Disposition');

    // Info: (20251022 - Luphia) 加入檔案相關標頭
    headers.set('Content-Type', 'application/octet-stream');
    // headers.set('Transfer-Encoding', 'chunked'); // Next.js/Node usually handles this for streams

    const downloadFilename = cid;
    const disposition = `attachment; filename="${downloadFilename}"`;
    headers.set('Content-Disposition', disposition);

    return new Response(bodyStream, {
      status: 200,
      headers: headers, // Info: (20251022 - Luphia) 使用包含 CORS 的標頭
    });

  } catch (error: unknown) {
    console.error('Download API error:', error);
    return jsonFail(ApiCode.SERVER_ERROR, (error as Error).message || 'Internal Server Error', { headers: corsHeaders });
  }
}
