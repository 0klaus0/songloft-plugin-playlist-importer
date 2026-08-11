/**
 * 歌单抓取器 — 从各平台 API 获取歌单曲目列表
 *
 * 同时提供跨平台搜索功能，用于歌单平台与洛雪音源平台不一致时的曲目匹配。
 */
/// <reference types="@songloft/plugin-sdk" />
import { PlaylistInfo, TrackInfo, Platform, LXSource, SearchResult } from './types';
import { fetchWithTimeout, decodeHtmlEntities } from './utils';
import { logInfo, logWarn, logError } from './logger';

// ==================== 工具函数 ====================

/**
 * 从艺术家数组中提取名称字符串
 */
function joinArtists(artists: { name?: string }[] | undefined): string {
  if (!artists || !Array.isArray(artists)) return '未知艺术家';
  return artists.map((a) => a.name || '').filter(Boolean).join('、') || '未知艺术家';
}

/**
 * 安全解析 JSON，失败时返回 null 而不是抛出。
 *
 * 修复：并发搜索时各音乐平台可能因限流/反爬返回 HTML、纯文本或截断 JSON，
 *       原来直接 JSON.parse(resp.body) 会抛 SyntaxError，导致整批解析失败。
 *       改为：
 *       1. 先用 trim() + 首字符快速判断
 *       2. 失败时尝试 JSON5 式宽松解析（容许末尾多余逗号）
 *       3. 解析失败返回 null，由调用方记录错误而不崩溃整个流程
 */
function safeJsonParse(text: string): Record<string, unknown> | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  // 快速判断：JSON 必须以 { 或 [ 开头，否则多半是错误页（HTML/纯文本）
  const first = trimmed[0];
  if (first !== '{' && first !== '[') {
    return null;
  }
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    // 容许末尾多余逗号（部分平台接口偶发返回非法 JSON）
    try {
      const fixed = trimmed.replace(/,\s*([}\]])/g, '$1');
      return JSON.parse(fixed) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}

// ==================== 网易云音乐 ====================

/**
 * 抓取网易云音乐歌单
 */
export async function fetchNeteasePlaylist(playlistId: string): Promise<PlaylistInfo> {
  const url = `https://music.163.com/api/v6/playlist/detail?id=${playlistId}&n=1000`;
  const resp = await fetchWithTimeout(url, {
    method: 'GET',
    headers: {
      'Referer': 'https://music.163.com',
      'Cookie': 'os=pc',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
  }, 15000);

  if (resp.status !== 200) {
    throw new Error(`网易云 API 回应状态码: ${resp.status}`);
  }

  const data = safeJsonParse(resp.body);
  if (!data || data.code !== 200 || !data.playlist) {
    throw new Error('网易云歌单数据格式异常或歌单不存在');
  }

  const playlist = data.playlist;
  const tracks: TrackInfo[] = (playlist.tracks || []).map((t: Record<string, unknown>) => ({
    title: decodeHtmlEntities(t.name as string || ''),
    artist: joinArtists(t.ar as { name?: string }[] | undefined),
    album: (t.al as Record<string, unknown>)?.name as string || '',
    duration: Math.floor((t.dt as number || 0) / 1000),
    platformSongId: String(t.id),
    platform: 'netease' as Platform,
  }));

  return {
    id: playlistId,
    platform: 'netease',
    name: decodeHtmlEntities(playlist.name || '未知歌单'),
    coverUrl: playlist.coverImgUrl || playlist.picUrl || '',
    creator: (playlist.creator as Record<string, unknown>)?.nickname as string || '',
    trackCount: tracks.length,
    tracks,
  };
}

/**
 * 搜索网易云音乐
 *
 * 修复：使用 safeJsonParse 防止平台返回 HTML/错误页时抛 SyntaxError
 */
export async function searchNetease(keyword: string, limit = 10): Promise<SearchResult[]> {
  const url = `https://music.163.com/api/search/get?s=${encodeURIComponent(keyword)}&type=1&limit=${limit}&offset=0`;
  const resp = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'Referer': 'https://music.163.com',
      'Cookie': 'os=pc',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
  }, 10000);

  const data = safeJsonParse(resp.body);
  if (!data || !data.result || !(data.result as Record<string, unknown>).songs) return [];

  const songs = (data.result as Record<string, unknown>).songs as Record<string, unknown>[];
  return songs.map((s) => ({
    songId: String(s.id),
    title: decodeHtmlEntities(s.name as string || ''),
    artist: joinArtists(s.artists as { name?: string }[] | undefined),
    album: (s.album as Record<string, unknown>)?.name as string || '',
    duration: Math.floor((s.duration as number || 0) / 1000),
    source: 'wy' as LXSource,
  }));
}

// ==================== QQ音乐 ====================

/**
 * 抓取QQ音乐歌单
 */
export async function fetchQQMusicPlaylist(playlistId: string): Promise<PlaylistInfo> {
  const url = `https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_by_ls_cpdata.fcg?type=1&json=1&utf8=1&onlysong=0&disstid=${playlistId}&format=json`;
  const resp = await fetchWithTimeout(url, {
    method: 'GET',
    headers: {
      'Referer': 'https://y.qq.com/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
  }, 15000);

  if (resp.status !== 200) {
    throw new Error(`QQ音乐 API 回应状态码: ${resp.status}`);
  }

  let body = resp.body.trim();
  if (body.startsWith('callback(')) {
    body = body.slice(9, -1);
  }
  if (body.startsWith('(')) {
    body = body.slice(1, -1);
  }

  const data = safeJsonParse(body);
  if (!data || !data.cdlist || !(data.cdlist as unknown[])[0]) {
    throw new Error('QQ音乐歌单数据格式异常或歌单不存在');
  }

  const cdlist = (data.cdlist as Record<string, unknown>[])[0];
  const tracks: TrackInfo[] = ((cdlist.songlist as Record<string, unknown>[]) || []).map((s) => ({
    title: decodeHtmlEntities(s.songname as string || s.name as string || ''),
    artist: joinArtists(s.singer as { name?: string }[] | undefined),
    album: s.albumname as string || '',
    duration: Math.floor((s.interval as number || 0)),
    platformSongId: s.songmid as string || '',
    platform: 'qqmusic' as Platform,
  })).filter((t: TrackInfo) => t.platformSongId);

  return {
    id: playlistId,
    platform: 'qqmusic',
    name: decodeHtmlEntities(cdlist.dissname || '未知歌单'),
    coverUrl: cdlist.logo || '',
    creator: cdlist.nickname || '',
    trackCount: tracks.length,
    tracks,
  };
}

/**
 * 搜索QQ音乐
 *
 * 修复：使用 safeJsonParse 防止平台返回非 JSON 时抛 SyntaxError
 */
export async function searchQQMusic(keyword: string, limit = 10): Promise<SearchResult[]> {
  const url = `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?w=${encodeURIComponent(keyword)}&format=json&n=${limit}&p=1&cr=1&g_tk=5381`;
  const resp = await fetchWithTimeout(url, {
    method: 'GET',
    headers: {
      'Referer': 'https://y.qq.com/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
  }, 10000);

  let body = resp.body.trim();
  if (body.startsWith('callback(')) {
    body = body.slice(9, -1);
  }

  const data = safeJsonParse(body);
  if (!data || !data.data || !(data.data as Record<string, unknown>).song) return [];
  const songData = (data.data as Record<string, unknown>).song as Record<string, unknown>;
  if (!songData.list) return [];

  return ((songData.list as Record<string, unknown>[]) || []).map((s) => ({
    songId: s.songmid as string || '',
    title: decodeHtmlEntities(s.songname as string || ''),
    artist: joinArtists(s.singer as { name?: string }[] | undefined),
    album: s.albumname as string || '',
    duration: Math.floor((s.interval as number || 0)),
    source: 'tx' as LXSource,
  })).filter((r) => r.songId);
}

// ==================== 酷我音乐 ====================

/**
 * 抓取酷我音乐歌单
 */
export async function fetchKuwoPlaylist(playlistId: string): Promise<PlaylistInfo> {
  const url = `http://nplserver.kuwo.cn/pl.svc?op=getlistinfo&pid=${playlistId}&pn=0&rn=200&encode=utf8&keyset=pl2012&identity=kuwo&pcmp4=1&vipver=1&newver=1`;
  const resp = await fetchWithTimeout(url, {
    method: 'GET',
    headers: {
      'Referer': 'http://www.kuwo.cn/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'csrf': 'ABCDEFGH',
      'Cookie': 'kw_token=ABCDEFGH',
    },
  }, 15000);

  if (resp.status !== 200) {
    throw new Error(`酷我 API 回应状态码: ${resp.status}`);
  }

  const data = safeJsonParse(resp.body);
  if (!data || !data.musiclist || (data.musiclist as unknown[]).length === 0) {
    throw new Error('酷我歌单数据格式异常或歌单不存在');
  }

  const tracks: TrackInfo[] = ((data.musiclist as Record<string, unknown>[]) || []).map((m) => ({
    title: decodeHtmlEntities(m.name as string || ''),
    artist: decodeHtmlEntities(m.artist as string || '未知艺术家'),
    album: m.album as string || '',
    duration: Math.floor((m.duration as number || 0)),
    platformSongId: String(m.id),
    platform: 'kuwo' as Platform,
  })).filter((t: TrackInfo) => t.platformSongId);

  return {
    id: playlistId,
    platform: 'kuwo',
    name: decodeHtmlEntities(data.title || '未知歌单'),
    coverUrl: data.pic || data.pic300 || '',
    creator: data.uname || '',
    trackCount: tracks.length,
    tracks,
  };
}

/**
 * 搜索酷我音乐
 *
 * 修复：使用 safeJsonParse 防止 SyntaxError；
 *       并发批量搜索酷我时易触发限流，返回 HTML/纯文本，
 *       原来 JSON.parse 直抛导致整批搜索失败。
 */
export async function searchKuwo(keyword: string, limit = 10): Promise<SearchResult[]> {
  const url = `http://search.kuwo.cn/r.s?all=${encodeURIComponent(keyword)}&ft=music&rn=${limit}&pn=0&encoding=utf8&rformat=json&vipver=1&pcmp4=1`;
  const resp = await fetchWithTimeout(url, {
    method: 'GET',
    headers: {
      'Referer': 'http://www.kuwo.cn/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
  }, 10000);

  const data = safeJsonParse(resp.body);
  if (!data || !data.abslist || (data.abslist as unknown[]).length === 0) return [];

  return ((data.abslist as Record<string, unknown>[]) || []).map((s) => ({
    songId: String(s.MUSICRID || '').replace('MUSIC_', ''),
    title: decodeHtmlEntities(s.SONGNAME as string || ''),
    artist: decodeHtmlEntities(s.ARTIST as string || '未知艺术家'),
    album: s.ALBUM as string || '',
    duration: Math.floor((s.DURATION as number || 0)),
    source: 'kw' as LXSource,
  })).filter((r) => r.songId);
}

// ==================== 酷狗音乐 ====================

/**
 * 抓取酷狗音乐歌单
 */
export async function fetchKugouPlaylist(playlistId: string): Promise<PlaylistInfo> {
  const infoUrl = `http://mobilecdn.kugou.com/api/v3/special/info?specialid=${playlistId}`;
  const infoResp = await fetchWithTimeout(infoUrl, {
    method: 'GET',
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  }, 10000);

  let playlistName = '未知歌单';
  let coverUrl = '';
  let creator = '';

  try {
    const infoData = safeJsonParse(infoResp.body);
    if (infoData && infoData.status === 1 && infoData.data) {
      const idata = infoData.data as Record<string, unknown>;
      playlistName = decodeHtmlEntities((idata.specialname as string) || '未知歌单');
      coverUrl = (idata.imgurl as string) || '';
      creator = (idata.nickname as string) || '';
    }
  } catch { /* 忽略 */ }

  const songsUrl = `http://mobilecdn.kugou.com/api/v3/special/song?specialid=${playlistId}&page=1&pagesize=200&version=9108`;
  const songsResp = await fetchWithTimeout(songsUrl, {
    method: 'GET',
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  }, 15000);

  if (songsResp.status !== 200) {
    throw new Error(`酷狗 API 回应状态码: ${songsResp.status}`);
  }

  const songsData = safeJsonParse(songsResp.body);
  if (!songsData || !songsData.data || !(songsData.data as Record<string, unknown>).info) {
    throw new Error('酷狗歌单数据格式异常或歌单不存在');
  }

  const tracks: TrackInfo[] = (((songsData.data as Record<string, unknown>).info as Record<string, unknown>[]) || []).map((s) => ({
    title: decodeHtmlEntities(s.filename as string || s.name as string || ''),
    artist: decodeHtmlEntities(s.singername as string || '未知艺术家'),
    album: s.album_name as string || '',
    duration: Math.floor((s.duration as number || 0)),
    platformSongId: String(s.audio_id || s.id || ''),
    platform: 'kugou' as Platform,
  })).filter((t: TrackInfo) => t.platformSongId && t.platformSongId !== '0');

  return {
    id: playlistId,
    platform: 'kugou',
    name: playlistName,
    coverUrl,
    creator,
    trackCount: tracks.length,
    tracks,
  };
}

/**
 * 搜索酷狗音乐
 *
 * 修复：使用 safeJsonParse 防止 SyntaxError
 */
export async function searchKugou(keyword: string, limit = 10): Promise<SearchResult[]> {
  const url = `http://mobilecdn.kugou.com/api/v3/search/song?keyword=${encodeURIComponent(keyword)}&pagesize=${limit}&page=1&version=9108`;
  const resp = await fetchWithTimeout(url, {
    method: 'GET',
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  }, 10000);

  const data = safeJsonParse(resp.body);
  if (!data || !data.data || !(data.data as Record<string, unknown>).info) return [];
  const infoData = (data.data as Record<string, unknown>).info as Record<string, unknown>[];

  return infoData.map((s) => ({
    songId: String(s.audio_id || s.id || ''),
    title: decodeHtmlEntities(s.songname as string || ''),
    artist: decodeHtmlEntities(s.singername as string || '未知艺术家'),
    album: s.album_name as string || '',
    duration: Math.floor((s.duration as number || 0)),
    source: 'kg' as LXSource,
  })).filter((r) => r.songId && r.songId !== '0');
}

// ==================== 汽水音乐 ====================

/**
 * 通过括号匹配算法从字符串中提取完整的 JSON 对象
 *
 * 用于处理大块 JSON（汽水音乐页面 _ROUTER_DATA 可能达 383KB），
 * 简单正则无法正确匹配嵌套的花括号，因此采用括号匹配算法，
 * 同时正确处理字符串内部的花括号和转义字符。
 *
 * @param str   源字符串
 * @param start 起始花括号 '{' 的索引位置
 * @returns 提取出的 JSON 字符串（含首尾花括号），匹配失败返回 null
 */
function extractJsonObjectByBraces(str: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < str.length; i++) {
    const ch = str[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return str.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * 尝试解析 JSON 字符串，失败时尝试修复末尾多余逗号后重试
 */
function tryParseJson(jsonStr: string): Record<string, unknown> | null {
  try {
    return JSON.parse(jsonStr) as Record<string, unknown>;
  } catch {
    try {
      const fixed = jsonStr.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
      return JSON.parse(fixed) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}

/**
 * 从汽水音乐分享页面提取 _ROUTER_DATA JSON
 *
 * 支持两种数据格式：
 * 1. 赋值式（新格式）：`_ROUTER_DATA = {...}` 或 `window._ROUTER_DATA = {...}`，
 *    位于 `<script data-script-src="modern-inline">` 标签内。由于 JSON 可能很大，
 *    使用括号匹配算法提取完整 JSON。
 * 2. 标签式（旧格式）：`<script id="_ROUTER_DATA">{...}</script>`。
 */
function extractRouterData(html: string): Record<string, unknown> | null {
  // 策略1: 赋值式格式 (window.)?_ROUTER_DATA = {...}
  // 使用括号匹配算法提取完整 JSON（避免正则在大 JSON 上的回溯问题）
  const assignPattern = /(?:window\.)?_ROUTER_DATA\s*=\s*(\{)/;
  const assignMatch = html.match(assignPattern);
  if (assignMatch && assignMatch.index !== undefined) {
    const braceStart = assignMatch.index + assignMatch[0].length - 1;
    const jsonStr = extractJsonObjectByBraces(html, braceStart);
    if (jsonStr) {
      const parsed = tryParseJson(jsonStr);
      if (parsed) return parsed;
    }
  }

  // 策略2: 标签式 <script id="_ROUTER_DATA">{...}</script>
  const tagPatterns = [
    /<script[^>]*id=["']_ROUTER_DATA["'][^>]*>(\{[\s\S]*?\})<\/script>/,
    /_ROUTER_DATA\s*=\s*(\{[\s\S]*?\});\s*<\/script>/,
    /_ROUTER_DATA\s*=\s*(\{[\s\S]*?\})\s*<\/script>/,
    /_ROUTER_DATA\s*=\s*(\{[\s\S]*?\});/,
  ];

  for (const pattern of tagPatterns) {
    const match = html.match(pattern);
    if (match) {
      const parsed = tryParseJson(match[1]);
      if (parsed) return parsed;
    }
  }
  return null;
}

/**
 * 递归查找对象中包含 trackName/trackInfo 的字段
 */
function findAudioData(obj: unknown): Record<string, unknown> | null {
  if (!obj || typeof obj !== 'object') return null;
  const record = obj as Record<string, unknown>;

  // 检查是否是包含 trackName 的音频数据
  if (record.trackName && (record.artistName || record.url)) {
    return record;
  }

  // 递归搜索
  for (const key of Object.keys(record)) {
    const val = record[key];
    if (val && typeof val === 'object') {
      const found = findAudioData(val);
      if (found) return found;
    }
  }
  return null;
}

/**
 * 递归查找所有音频数据（用于歌单分享，可能包含多首歌曲）
 *
 * 支持两种数据结构：
 * 1. 新结构：`type === 'track'` 且有 `entity.track` 的对象，从 `entity.track` 提取曲目数据。
 *    典型路径为 `loaderData.playlist_page.medias[]`，每个元素形如
 *    `{ type: "track", entity: { track: {...} } }`。
 * 2. 旧结构（备选）：包含 `trackName` 字段的对象。
 */
function findAllAudioData(obj: unknown, results: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (!obj || typeof obj !== 'object') return results;
  const record = obj as Record<string, unknown>;

  // 策略1（新结构）: type === 'track' 且有 entity.track，从 entity.track 提取曲目数据
  if (record.type === 'track' && record.entity && typeof record.entity === 'object') {
    const entity = record.entity as Record<string, unknown>;
    if (entity.track && typeof entity.track === 'object') {
      results.push(entity.track as Record<string, unknown>);
      return results;
    }
  }

  // 策略2（旧结构备选）: 检查是否是包含 trackName 的音频数据
  if (record.trackName && (record.artistName || record.url)) {
    results.push(record);
    return results;
  }

  // 递归搜索
  for (const key of Object.keys(record)) {
    const val = record[key];
    if (Array.isArray(val)) {
      for (const item of val) {
        findAllAudioData(item, results);
      }
    } else if (val && typeof val === 'object') {
      findAllAudioData(val, results);
    }
  }
  return results;
}

/**
 * 从汽水音乐 track 对象的 album.url_cover 中提取封面 URL
 *
 * url_cover 可能是字符串，也可能是对象（含 urls 数组或 uri 字段）。
 * 旧结构则回退到 track.coverURL 字段。
 */
function extractQishuiCoverUrl(track: Record<string, unknown>): string {
  const album = track.album as Record<string, unknown> | undefined;
  if (!album || typeof album !== 'object') {
    return String(track.coverURL || '');
  }
  const urlCover = album.url_cover as Record<string, unknown> | string | undefined;
  if (!urlCover) {
    return String(track.coverURL || '');
  }
  if (typeof urlCover === 'string') {
    return urlCover;
  }
  if (typeof urlCover === 'object') {
    const urlCoverObj = urlCover as Record<string, unknown>;
    if (Array.isArray(urlCoverObj.urls) && urlCoverObj.urls.length > 0) {
      return String(urlCoverObj.urls[0]);
    }
    if (urlCoverObj.uri) {
      return String(urlCoverObj.uri);
    }
  }
  return String(track.coverURL || '');
}

/**
 * 抓取汽水音乐分享内容
 *
 * 汽水音乐分享链接格式：
 * - qishui.douyin.com/s/XXXXX（单曲分享）
 * - ssmusic.com/share/playlist/XXXXX（歌单分享）
 *
 * 解析方式：获取分享页面 HTML，提取 _ROUTER_DATA 中的曲目信息。
 * 由于汽水音乐无直接对应的洛雪音源，导入时会自动跨平台搜索匹配。
 */
export async function fetchQishuiPlaylist(shareId: string): Promise<PlaylistInfo> {
  // 构建分享 URL
  const shareUrl = shareId.startsWith('http')
    ? shareId
    : `https://qishui.douyin.com/s/${shareId}/`;

  logInfo(`抓取汽水音乐分享: ${shareUrl}`);

  let resp;
  try {
    resp = await fetchWithTimeout(shareUrl, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
    }, 20000);
  } catch (e) {
    logError(`汽水音乐页面请求异常: ${String(e)}`);
    throw new Error(`汽水音乐页面请求失败: ${String(e)}`);
  }

  logInfo(`汽水音乐页面响应: status=${resp.status}, body长度=${resp.body ? resp.body.length : 0}`);

  if (resp.status !== 200) {
    throw new Error(`汽水音乐页面请求失败: HTTP ${resp.status}`);
  }

  const html = resp.body;
  if (!html || html.trim() === '') {
    logError('汽水音乐页面响应体为空');
    throw new Error('汽水音乐页面响应体为空，可能是网络问题或被重定向');
  }

  // 检查是否包含 _ROUTER_DATA
  if (html.indexOf('_ROUTER_DATA') === -1) {
    logWarn(`页面中未找到 _ROUTER_DATA，HTML 前500字符: ${html.substring(0, 500)}`);
    throw new Error('汽水音乐页面结构已变更或链接已失效');
  }

  // 提取 _ROUTER_DATA
  const routerData = extractRouterData(html);
  if (!routerData) {
    logError('无法从页面提取 _ROUTER_DATA JSON');
    throw new Error('无法从汽水音乐页面提取数据，可能是链接已失效或页面结构已变更');
  }
  logInfo('成功提取 _ROUTER_DATA');

  // 查找所有音频数据
  const audioDataList = findAllAudioData(routerData);

  logInfo(`汽水音乐找到 ${audioDataList.length} 首曲目`);

  if (audioDataList.length === 0) {
    logError('汽水音乐分享中未找到曲目信息');
    throw new Error('汽水音乐分享中未找到曲目信息');
  }

  // 解析曲目列表
  // 新数据结构: track 对象包含 name, artists, album, duration, id, vid
  // 旧结构备选: trackName, artistName 等
  const tracks: TrackInfo[] = audioDataList.map((audio) => {
    // 歌名: track.name（新结构，不是 trackName）
    const title = decodeHtmlEntities(String(audio.name || audio.trackName || '未知歌曲'));

    // 艺术家: 从 artists 数组提取（新结构），每个元素有 name 或 simple_display_name
    let artist = '未知艺术家';
    if (Array.isArray(audio.artists)) {
      const names = (audio.artists as Record<string, unknown>[])
        .map((a) => String(a.name || a.simple_display_name || ''))
        .filter(Boolean);
      if (names.length > 0) {
        artist = decodeHtmlEntities(names.join('、'));
      }
    } else if (audio.artistName) {
      artist = decodeHtmlEntities(String(audio.artistName));
    }

    // 专辑: album 是对象（新结构），有 name 字段
    let album = '';
    const albumObj = audio.album as Record<string, unknown> | undefined;
    if (albumObj && typeof albumObj === 'object' && albumObj.name) {
      album = decodeHtmlEntities(String(albumObj.name));
    } else if (typeof audio.album === 'string' && audio.album) {
      album = decodeHtmlEntities(String(audio.album));
    }

    // 时长: duration 为毫秒（新结构），需要转换为秒；旧结构可能已是秒
    const durationMs = Number(audio.duration || 0);
    const duration = durationMs > 1000 ? Math.floor(durationMs / 1000) : Math.floor(durationMs);

    // 曲目ID: track.id（新结构）
    const platformSongId = String(audio.id || audio.vid || audio.trackName || '');

    return {
      title,
      artist,
      album,
      duration,
      platformSongId,
      platform: 'qishui' as Platform,
    };
  });

  // 尝试从页面数据中提取歌单名称和元信息
  // 歌单信息可能在 loaderData.playlist_layout 或 loaderData.playlist_page.playlistInfo 中
  let playlistName = '';
  let coverUrlFromPlaylist = '';
  let creatorName = '';
  const loaderData = (routerData.loaderData || routerData.loader_data) as Record<string, unknown> | undefined;
  if (loaderData) {
    const playlistLayout = loaderData.playlist_layout as Record<string, unknown> | undefined;
    const playlistPage = loaderData.playlist_page as Record<string, unknown> | undefined;

    // 歌单名称：优先 playlist_layout，其次 playlist_page.playlistInfo
    const candidateTitle = playlistLayout?.title || playlistPage?.title
      || playlistLayout?.name;
    if (candidateTitle) {
      playlistName = decodeHtmlEntities(String(candidateTitle));
    }

    // 从 playlistInfo 提取歌单元信息
    const playlistInfo = playlistPage?.playlistInfo as Record<string, unknown> | undefined;
    if (playlistInfo) {
      if (!playlistName && playlistInfo.title) {
        playlistName = decodeHtmlEntities(String(playlistInfo.title));
      }
      // 封面 URL
      const urlCover = playlistInfo.url_cover as Record<string, unknown> | undefined;
      if (urlCover) {
        if (Array.isArray(urlCover.urls) && urlCover.urls.length > 0) {
          coverUrlFromPlaylist = String(urlCover.urls[0]);
        } else if (urlCover.uri) {
          coverUrlFromPlaylist = String(urlCover.uri);
        }
      }
      // 创建者
      const owner = playlistInfo.owner as Record<string, unknown> | undefined;
      if (owner?.nickname) {
        creatorName = String(owner.nickname);
      }
    }
  }

  // 如果找不到歌单名称，使用默认名称
  if (!playlistName) {
    playlistName = tracks.length > 1
      ? `汽水音乐分享 (${tracks.length}首)`
      : String(tracks[0]?.title || '汽水音乐分享');
  }

  // 封面优先使用歌单封面，其次使用第一首曲目的封面
  const firstAudio = audioDataList[0];
  const coverUrl = coverUrlFromPlaylist || extractQishuiCoverUrl(firstAudio);

  return {
    id: shareId,
    platform: 'qishui',
    name: playlistName,
    coverUrl,
    creator: creatorName || '汽水音乐',
    trackCount: tracks.length,
    tracks,
  };
}

// ==================== 统一接口 ====================

/** 各平台歌单抓取函数映射 */
const PLAYLIST_FETCHERS: Record<Platform, (id: string) => Promise<PlaylistInfo>> = {
  netease: fetchNeteasePlaylist,
  qqmusic: fetchQQMusicPlaylist,
  kuwo: fetchKuwoPlaylist,
  kugou: fetchKugouPlaylist,
  qishui: fetchQishuiPlaylist,
};

/** 各平台搜索函数映射 */
const SEARCH_FUNCTIONS: Partial<Record<LXSource, (keyword: string, limit?: number) => Promise<SearchResult[]>>> = {
  wy: searchNetease,
  tx: searchQQMusic,
  kw: searchKuwo,
  kg: searchKugou,
  // 咪咕暂不支持搜索
};

/**
 * 抓取歌单（统一入口）
 */
export async function fetchPlaylist(platform: Platform, playlistId: string): Promise<PlaylistInfo> {
  const fetcher = PLAYLIST_FETCHERS[platform];
  if (!fetcher) {
    throw new Error(`不支持的平台: ${platform}`);
  }
  logInfo(`开始抓取歌单: platform=${platform}, id=${playlistId}`);
  const playlist = await fetcher(playlistId);
  logInfo(`歌单抓取完成: ${playlist.name}, 共 ${playlist.tracks.length} 首`);
  return playlist;
}

/**
 * 搜索歌曲（统一入口）
 *
 * 修复：捕获单个平台搜索失败，确保一个平台出错不影响其他平台（阶段 1 顺序处理时），
 *       并发搜索时也避免一个错误导致整组 Promise.all reject。
 */
export async function searchMusic(
  keyword: string,
  source: LXSource,
  limit = 10
): Promise<SearchResult[]> {
  const searcher = SEARCH_FUNCTIONS[source];
  if (!searcher) {
    logWarn(`不支持的搜索来源: ${source}`);
    return [];
  }
  try {
    return await searcher(keyword, limit);
  } catch (e) {
    logWarn(`搜索异常: ${source} "${keyword}" - ${String(e)}`);
    return [];
  }
}
