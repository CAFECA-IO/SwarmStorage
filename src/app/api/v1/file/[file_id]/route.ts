import { NextRequest, NextResponse } from 'next/server';
import { name, version } from '@/package';

const POWER_BY_STRING = `${name} v${version}`;
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
      // Info: (20251022 - Luphia) 未提供 File ID 時的錯誤回應
      return NextResponse.json({
        powerby: POWER_BY_STRING,
        success: false,
        code: "BAD_REQUEST",
        message: "File ID is required",
        payload: null
      }, {
        status: 400,
        headers: corsHeaders
      });
    }

    const apiUrl = `${IPFS_API_URL}/api/v0/cat?arg=${cid}`;
    const ipfsResponse = await fetch(apiUrl, {
      method: 'POST',
    });

    if (!ipfsResponse.ok) {
      // Info: (20251022 - Luphia) 處理 IPFS API 錯誤回應（可能是檔案不存在或服務異常）
      const errorText = await ipfsResponse.text();
      return NextResponse.json({
        powerby: POWER_BY_STRING,
        success: false,
        code: "NOT_FOUND",
        message: "File not found on IPFS or API error",
        payload: { details: errorText }
      }, {
        status: 404,
        headers: corsHeaders
      });
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
    headers.set('Content-Length', ipfsResponse.headers.get('Content-Length') || '');

    const downloadFilename = cid;
    const disposition = `attachment; filename="${downloadFilename}"`;
    headers.set('Content-Disposition', disposition);

    return new Response(bodyStream, {
      status: 200,
      headers: headers, // Info: (20251022 - Luphia) 使用包含 CORS 的標頭
    });

  } catch (error: unknown) {
    console.error('Download API error:', error);
    // Info: (20251022 - Luphia) 在錯誤回應中加入 CORS 標頭
    return NextResponse.json({
      powerby: POWER_BY_STRING, // 使用動態值
      success: false,
      code: "INTERNAL_ERROR",
      message: (error as Error).message || 'Internal Server Error',
      payload: null
    }, {
      status: 500,
      headers: corsHeaders
    });
  }
}
