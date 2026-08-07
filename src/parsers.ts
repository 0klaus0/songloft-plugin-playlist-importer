/**
 * 分享链接解析器 — 识别各平台歌单分享链接
 *
 * 支持平台：网易云音乐、QQ音乐、酷我音乐、酷狗音乐、汽水音乐
 * 支持格式：完整 URL、短链接、App 分享文字
 */
import { ParsedShareLink, Platform, PLATFORM_NAMES } from './types';
import { extractUrls, fetchWithTimeout } from './utils';

/** 各平台 URL 匹配规则 */
interface MatchRule {
  platform: Platform;
  patterns: RegExp[];
  extractId: (url: string) => string | null;
}

const MATCH_RULES: MatchRule[] = [
  // === 网易云音乐 ===
  {
    platform: 'netease',
    patterns: [
      /music\.163\.com\/playlist/i,
      /music\.163\.com\/#\/playlist/i,
      /y\.music\.163\.com\/.*playlist/i,
      /163cn\.tv\//i, // 短链接
    ],
    extractId(url: string): string | null {
      let match = url.match(/[?&]id=(\d+)/);
      if (match) return match[1];
      match = url.match(/\/playlist\/?(\d+)/);
      if (match) return match[1];
      return null;
    },
  },
  // === QQ音乐 ===
  {
    platform: 'qqmusic',
    patterns: [
      /y\.qq\.com\/.*playlist/i,
      /y\.qq\.com\/.*playsquare/i,
      /c\.y\.qq\.com\/.*playlist/i,
      /url\.cn\//i, // QQ短链接
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
  // === 酷我音乐 ===
  {
    platform: 'kuwo',
    patterns: [
      /kuwo\.cn\/.*playlist/i,
      /kuwo\.cn\/playlists/i,
      /kuwo\.cn\/playlist_detail/i,
      /t\.cn\//i, // 可能的短链接
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
  // === 酷狗音乐 ===
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
  // === 汽水音乐 ===
  {
    platform: 'qishui',
    patterns: [
      /qishui\.douyin\.com\/s\/[a-zA-Z0-9]+/i,
      /ssmusic\.com\/share\/playlist/i,
      /ssmusic\.com\/share\/song/i,
    ],
    extractId(url: string): string | null {
      // qishui.douyin.com/s/XXXXX 格式
      let match = url.match(/\/s\/([a-zA-Z0-9]+)/);
      if (match) return match[1];
      // ssmusic.com/share/playlist/XXXXX 格式
      match = url.match(/\/share\/(?:playlist|song)\/([a-zA-Z0-9]+)/);
      if (match) return match[1];
      return null;
    },
  },
];

/** 已知的短链接域名，需要跟随重定向 */
const SHORT_LINK_DOMAINS = ['163cn.tv', 'url.cn', 't.cn', 'tb.cn', 'dwz.cn', 'qishui.douyin.com'];

/**
 * 检查 URL 是否为短链接
 */
function isShortLink(url: string): boolean {
  return SHORT_LINK_DOMAINS.some((domain) => url.includes(domain));
}

/**
 * 跟随短链接重定向，取得最终 URL
 */
async function resolveShortLink(url: string): Promise<string> {
  try {
    const resp = await fetchWithTimeout(url, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'X-Fetch-No-Redirect': 'true' },
    }, 8000);

    const location = resp.headers['location'] || resp.headers['Location'];
    if (location) {
      if (location.startsWith('/')) {
        const urlObj = new URL(url);
        return `${urlObj.protocol}//${urlObj.host}${location}`;
      }
      return location;
    }

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
 * 尝试用规则匹配 URL，返回平台和歌单 ID
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
 * 解析分享文字，识别歌单链接
 *
 * @param text 用户粘贴的分享文字（可能包含 URL、描述文字等）
 * @returns 解析结果，若无法识别则返回 null
 */
export async function parseShareLink(text: string): Promise<ParsedShareLink | null> {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // 步骤 1：从文字中提取所有 URL
  const urls = extractUrls(trimmed);
  if (urls.length === 0) return null;

  // 步骤 2：逐一尝试匹配
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

    // 步骤 3：如果是短链接，跟随重定向后再匹配
    if (isShortLink(url)) {
      songloft.log.info(`解析短链接: ${url}`);
      const resolvedUrl = await resolveShortLink(url);
      if (resolvedUrl !== url) {
        songloft.log.info(`短链接重定向至: ${resolvedUrl}`);
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
 * 取得所有支持的平台列表
 */
export function getSupportedPlatforms(): { key: Platform; name: string }[] {
  return (Object.keys(PLATFORM_NAMES) as Platform[]).map((key) => ({
    key,
    name: PLATFORM_NAMES[key],
  }));
}
