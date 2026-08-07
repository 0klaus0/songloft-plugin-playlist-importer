/**
 * 分享連結解析器 — 識別各平台歌單分享連結
 *
 * 支援平台：網易雲音樂、QQ音樂、酷我音樂、酷狗音樂
 * 支援格式：完整 URL、短連結、App 分享文字
 */
import { ParsedShareLink, Platform, PLATFORM_NAMES } from './types';
import { extractUrls, fetchWithTimeout } from './utils';

/** 各平台 URL 匹配規則 */
interface MatchRule {
  platform: Platform;
  patterns: RegExp[];
  extractId: (url: string) => string | null;
}

const MATCH_RULES: MatchRule[] = [
  // === 網易雲音樂 ===
  {
    platform: 'netease',
    patterns: [
      /music\.163\.com\/playlist/i,
      /music\.163\.com\/#\/playlist/i,
      /y\.music\.163\.com\/.*playlist/i,
      /163cn\.tv\//i, // 短連結
    ],
    extractId(url: string): string | null {
      // 從查詢參數中提取 id
      let match = url.match(/[?&]id=(\d+)/);
      if (match) return match[1];
      // 從路徑中提取
      match = url.match(/\/playlist\/?(\d+)/);
      if (match) return match[1];
      return null;
    },
  },
  // === QQ音樂 ===
  {
    platform: 'qqmusic',
    patterns: [
      /y\.qq\.com\/.*playlist/i,
      /y\.qq\.com\/.*playsquare/i,
      /c\.y\.qq\.com\/.*playlist/i,
      /url\.cn\//i, // QQ短連結
    ],
    extractId(url: string): string | null {
      let match = url.match(/\/playlist\/([A-Za-z0-9]+)/);
      if (match) return match[1];
      match = url.match(/[?&]id=([A-Za-z0-9]+)/);
      if (match) return match[1];
      match = url.match(/[?&]disstid=([A-Za-z0-9]+)/);
      if (match) return match[1];
      return null;
    },
  },
  // === 酷我音樂 ===
  {
    platform: 'kuwo',
    patterns: [
      /kuwo\.cn\/.*playlist/i,
      /kuwo\.cn\/playlists/i,
      /kuwo\.cn\/playlist_detail/i,
      /t\.cn\//i, // 可能的短連結
    ],
    extractId(url: string): string | null {
      let match = url.match(/\/playlist_detail\/?(\d+)/);
      if (match) return match[1];
      match = url.match(/\/playlists\/?(\d+)/);
      if (match) return match[1];
      match = url.match(/[?&]pid=(\d+)/);
      if (match) return match[1];
      match = url.match(/[?&]id=(\d+)/);
      if (match) return match[1];
      return null;
    },
  },
  // === 酷狗音樂 ===
  {
    platform: 'kugou',
    patterns: [
      /kugou\.com\/.*special/i,
      /kugou\.com\/.*plist/i,
      /m\.kugou\.com\/plist/i,
    ],
    extractId(url: string): string | null {
      let match = url.match(/\/special\/single\/(\d+)/);
      if (match) return match[1];
      match = url.match(/\/plist\/list\/(\d+)/);
      if (match) return match[1];
      match = url.match(/[?&]specialid=(\d+)/);
      if (match) return match[1];
      match = url.match(/[?&]id=(\d+)/);
      if (match) return match[1];
      return null;
    },
  },
];

/** 已知的短連結域名，需要跟隨重定向 */
const SHORT_LINK_DOMAINS = ['163cn.tv', 'url.cn', 't.cn', 'tb.cn', 'dwz.cn'];

/**
 * 檢查 URL 是否為短連結
 */
function isShortLink(url: string): boolean {
  return SHORT_LINK_DOMAINS.some((domain) => url.includes(domain));
}

/**
 * 跟隨短連結重定向，取得最終 URL
 */
async function resolveShortLink(url: string): Promise<string> {
  try {
    const resp = await fetchWithTimeout(url, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'X-Fetch-No-Redirect': 'true' },
    }, 8000);

    // 嘗試從 Location header 取得重定向位址
    const location = resp.headers['location'] || resp.headers['Location'];
    if (location) {
      // 如果是相對路徑，補全
      if (location.startsWith('/')) {
        const urlObj = new URL(url);
        return `${urlObj.protocol}//${urlObj.host}${location}`;
      }
      return location;
    }

    // 如果回應是 HTML，嘗試從中提取 URL
    if (resp.body && resp.body.includes('http')) {
      const urls = extractUrls(resp.body);
      if (urls.length > 0) return urls[0];
    }

    return url;
  } catch {
    return url;
  }
}

/**
 * 嘗試用規則匹配 URL，回傳平台和歌單 ID
 */
function matchUrl(url: string): { platform: Platform; playlistId: string } | null {
  for (const rule of MATCH_RULES) {
    const matched = rule.patterns.some((p) => p.test(url));
    if (!matched) continue;

    const playlistId = rule.extractId(url);
    if (playlistId) {
      return { platform: rule.platform, playlistId };
    }
  }
  return null;
}

/**
 * 解析分享文字，識別歌單連結
 *
 * @param text 使用者貼上的分享文字（可能包含 URL、描述文字等）
 * @returns 解析結果，若無法識別則回傳 null
 */
export async function parseShareLink(text: string): Promise<ParsedShareLink | null> {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // 步驟 1：從文字中提取所有 URL
  const urls = extractUrls(trimmed);
  if (urls.length === 0) return null;

  // 步驟 2：逐一嘗試匹配
  for (const url of urls) {
    // 直接匹配
    let result = matchUrl(url);
    if (result) {
      return {
        platform: result.platform,
        playlistId: result.playlistId,
        url,
        rawText: trimmed,
      };
    }

    // 步驟 3：如果是短連結，跟隨重定向後再匹配
    if (isShortLink(url)) {
      songloft.log.info(`解析短連結: ${url}`);
      const resolvedUrl = await resolveShortLink(url);
      if (resolvedUrl !== url) {
        songloft.log.info(`短連結重定向至: ${resolvedUrl}`);
        result = matchUrl(resolvedUrl);
        if (result) {
          return {
            platform: result.platform,
            playlistId: result.playlistId,
            url: resolvedUrl,
            rawText: trimmed,
          };
        }
      }
    }
  }

  return null;
}

/**
 * 取得所有支援的平台列表
 */
export function getSupportedPlatforms(): { key: Platform; name: string }[] {
  return (Object.keys(PLATFORM_NAMES) as Platform[]).map((key) => ({
    key,
    name: PLATFORM_NAMES[key],
  }));
}
