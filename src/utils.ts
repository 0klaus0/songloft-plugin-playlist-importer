/**
 * 工具函数
 */
/// <reference types="@songloft/plugin-sdk" />

/**
 * 创建 JSON 回应
 */
export function jsonResponse(data: unknown, statusCode = 200): HTTPResponse {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(data),
  };
}

/**
 * 创建错误回应
 */
export function errorResponse(message: string, statusCode = 400): HTTPResponse {
  return jsonResponse({ success: false, error: message }, statusCode);
}

/**
 * 将 Uint8Array 或 string 转为 string
 */
function bodyToString(body: Uint8Array | string | null): string {
  if (!body) return '';
  if (typeof body === 'string') return body;
  // Uint8Array → string (UTF-8)
  let result = '';
  const len = body.length;
  for (let i = 0; i < len; i++) {
    result += String.fromCharCode(body[i]);
  }
  // 处理多字节 UTF-8
  try {
    return decodeURIComponent(escape(result));
  } catch {
    return result;
  }
}

/**
 * 解析请求 body 为 JSON
 * 注意：Songloft QuickJS 运行时中 req.body 是 Uint8Array | null，不是 string
 */
export function parseBody<T = Record<string, unknown>>(body: Uint8Array | string | null): T {
  const text = bodyToString(body);
  if (text.trim() === '') return {} as T;
  return JSON.parse(text) as T;
}

/**
 * 从 URL 中提取查询参数
 */
export function parseQueryString(query: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!query) return result;
  const pairs = query.split('&');
  for (const pair of pairs) {
    const [key, value] = pair.split('=');
    if (key) result[decodeURIComponent(key)] = decodeURIComponent(value || '');
  }
  return result;
}

/**
 * 从文字中提取 URL
 */
export function extractUrls(text: string): string[] {
  const urlRegex = /https?:\/\/[^\s<>"']+/gi;
  return text.match(urlRegex) || [];
}

/**
 * 安全的 fetch 包装，带超时
 *
 * Songloft QuickJS fetch polyfill 支持两个内部控制头：
 * - X-Fetch-Timeout-Ms: 设置超时（100-30000ms）
 * - X-Fetch-No-Redirect: 禁止自动跟随重定向
 */
export async function fetchWithTimeout(
  url: string,
  options: Record<string, unknown> = {},
  timeoutMs = 15000
): Promise<{ status: number; body: string; headers: Record<string, string> }> {
  // 合并 headers，加入超时控制头
  const userHeaders = (options.headers as Record<string, string>) || {};
  const headers: Record<string, string> = {
    'X-Fetch-Timeout-Ms': String(Math.min(Math.max(timeoutMs, 100), 30000)),
    ...userHeaders,
  };

  // 构建 fetch options，移除可能不被支持的字段
  const fetchOptions: Record<string, unknown> = {
    method: options.method || 'GET',
    headers,
  };
  if (options.body !== undefined) {
    fetchOptions.body = options.body;
  }

  const resp = await fetch(url, fetchOptions);
  const body = await resp.text();

  // 安全地提取 headers（QuickJS 的 headers 可能不支持 forEach）
  const respHeaders: Record<string, string> = {};
  if (resp.headers) {
    if (typeof resp.headers.forEach === 'function') {
      resp.headers.forEach((value: string, key: string) => {
        respHeaders[key] = value;
        respHeaders[key.toLowerCase()] = value;
      });
    } else if (typeof resp.headers === 'object') {
      // 可能是普通对象
      const h = resp.headers as Record<string, string>;
      for (const key of Object.keys(h)) {
        respHeaders[key] = h[key];
        respHeaders[key.toLowerCase()] = h[key];
      }
    }
  }

  return { status: resp.status, body, headers: respHeaders };
}

/**
 * HTML 实体解码
 */
export function decodeHtmlEntities(text: string): string {
  const entities: Record<string, string> = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&apos;': "'",
    '&nbsp;': ' ',
  };
  return text.replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(parseInt(code, 10)))
    .replace(/&[a-z]+;/gi, (match) => entities[match] || match);
}

/**
 * 清理文件名中的非法字符
 */
export function sanitizeFilename(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'unknown';
}

/**
 * 格式化时间（秒 → mm:ss）
 */
export function formatDuration(seconds: number): string {
  if (!seconds || seconds < 0) return '00:00';
  const min = Math.floor(seconds / 60);
  const sec = Math.floor(seconds % 60);
  return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

/**
 * 延迟函数
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
