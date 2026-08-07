/**
 * 工具函数
 */
import { HttpResponse } from './types';

/**
 * 创建 JSON 回应
 */
export function jsonResponse(data: unknown, statusCode = 200): HttpResponse {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(data),
  };
}

/**
 * 创建错误回应
 */
export function errorResponse(message: string, statusCode = 400): HttpResponse {
  return jsonResponse({ success: false, error: message }, statusCode);
}

/**
 * 解析请求 body 为 JSON
 */
export function parseBody<T = Record<string, unknown>>(body: string): T {
  if (!body || body.trim() === '') return {} as T;
  return JSON.parse(body) as T;
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
 */
export async function fetchWithTimeout(
  url: string,
  options: Record<string, unknown> = {},
  timeoutMs = 15000
): Promise<{ status: number; body: string; headers: Record<string, string> }> {
  const headers: Record<string, string> = {
    'X-Fetch-Timeout-Ms': String(timeoutMs),
    ...(options.headers as Record<string, string> || {}),
  };
  const resp = await fetch(url, { ...options, headers });
  const body = await resp.text();
  const respHeaders: Record<string, string> = {};
  resp.headers.forEach((value: string, key: string) => {
    respHeaders[key] = value;
  });
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
