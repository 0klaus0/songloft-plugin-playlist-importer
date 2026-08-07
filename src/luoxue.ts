/**
 * 洛雪音源客户端 — 通过配置的洛雪音源 API 服务器获取音乐下载链接
 *
 * 支持的服务器类型：
 * - lx-source (Go): GET /link/:source/:songId/:quality
 * - lx-music-api-server (Python): GET /url?source=&id=&quality=
 * - 通用自定义服务器: GET /url?source=&id=&quality=
 *
 * 同时提供跨平台搜索匹配功能：当歌单来源平台与洛雪音源平台不一致时，
 * 通过搜索目标平台找到对应歌曲 ID，再获取下载链接。
 */
/// <reference types="@songloft/plugin-sdk" />
import { PluginConfig, TrackInfo, LXSource, PLATFORM_TO_LX, SearchResult } from './types';
import { fetchWithTimeout } from './utils';
import { searchMusic as searchOnPlatform } from './fetchers';

/** 洛雪音源获取结果 */
export interface LuoxueResult {
  url: string;
  source: LXSource;
  songId: string;
  quality: string;
  matched: boolean;
}

/**
 * 构建 API 请求 URL（自动适配不同服务器格式）
 */
function buildApiUrl(config: PluginConfig, source: LXSource, songId: string, quality: string): string {
  const base = config.luoxueApiUrl.replace(/\/+$/, '');
  // lx-source (Go) 格式: /link/:s/:id/:q
  if (base.includes('/link/') || config.luoxueApiUrl.includes('lx-source')) {
    return `${base}/link/${source}/${songId}/${quality}`;
  }
  // 通用格式: /url?source=&id=&quality=
  const sep = base.includes('?') ? '&' : '?';
  const params = `source=${source}&id=${songId}&quality=${quality}`;
  let url = `${base}${sep}${params}`;
  if (config.luoxueApiPass) {
    url += `&key=${encodeURIComponent(config.luoxueApiPass)}`;
  }
  return url;
}

/**
 * 通过洛雪音源 API 获取音乐下载链接
 *
 * @param config 插件配置
 * @param source 音源（kw/kg/tx/wy/mg）
 * @param songId 歌曲 ID
 * @param quality 音质
 */
export async function getMusicUrl(
  config: PluginConfig,
  source: LXSource,
  songId: string,
  quality: string
): Promise<string | null> {
  const url = buildApiUrl(config, source, songId, quality);
  songloft.log.info(`洛雪音源请求: ${url}`);

  try {
    const resp = await fetchWithTimeout(url, {
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0' },
    }, 15000);

    if (resp.status !== 200) {
      songloft.log.warn(`洛雪音源回应状态码: ${resp.status}`);
      return null;
    }

    // 尝试解析 JSON 回应
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(resp.body);
    } catch {
      // 如果不是 JSON，可能直接是 URL
      const trimmed = resp.body.trim();
      if (trimmed.startsWith('http')) return trimmed;
      return null;
    }

    // 不同服务器格式的回应解析
    // 格式1: { "url": "http://..." }
    if (data.url && typeof data.url === 'string') {
      return data.url as string;
    }
    // 格式2: { "data": "http://..." } 或 { "data": { "url": "http://..." } }
    if (data.data) {
      if (typeof data.data === 'string') return data.data as string;
      if (typeof data.data === 'object' && data.data !== null) {
        const dataObj = data.data as Record<string, unknown>;
        if (dataObj.url) return dataObj.url as string;
        if (dataObj.link) return dataObj.link as string;
      }
    }
    // 格式3: { "code": 0, "data": "http://..." }
    if (data.code !== undefined && data.code !== 0) {
      songloft.log.warn(`洛雪音源回应错误: code=${data.code}, msg=${data.msg || data.message || ''}`);
      return null;
    }
    // 格式4: { "link": "http://..." }
    if (data.link && typeof data.link === 'string') {
      return data.link as string;
    }

    songloft.log.warn('洛雪音源回应中未找到有效的 URL');
    return null;
  } catch (e) {
    songloft.log.error(`洛雪音源请求失败: ${String(e)}`);
    return null;
  }
}

/**
 * 跨平台匹配：在目标音源平台搜索歌曲，找到对应的 songId
 *
 * 当歌单来源平台与洛雪音源平台不一致时使用。
 * 例如：歌单来自网易云，但洛雪音源只支持酷我，则在酷我搜索同名歌曲。
 *
 * @param track 原始曲目信息
 * @param targetSource 目标音源平台
 * @returns 匹配到的歌曲 ID，若无匹配则返回 null
 */
export async function crossPlatformMatch(
  track: TrackInfo,
  targetSource: LXSource
): Promise<string | null> {
  const keyword = `${track.title} ${track.artist}`.trim();
  songloft.log.info(`跨平台搜索: "${keyword}" on ${targetSource}`);

  try {
    const results: SearchResult[] = await searchOnPlatform(keyword, targetSource, 5);
    if (results.length === 0) {
      songloft.log.warn(`跨平台搜索无结果: "${keyword}"`);
      return null;
    }

    // 尝试精确匹配
    for (const r of results) {
      const titleMatch = r.title.toLowerCase().includes(track.title.toLowerCase()) ||
        track.title.toLowerCase().includes(r.title.toLowerCase());
      const artistMatch = r.artist.toLowerCase().includes(track.artist.toLowerCase()) ||
        track.artist.toLowerCase().includes(r.artist.toLowerCase()) ||
        track.artist === '未知艺术家';

      if (titleMatch && artistMatch) {
        songloft.log.info(`跨平台匹配成功: "${track.title}" → "${r.title}" (${r.songId})`);
        return r.songId;
      }
    }

    // 如果没有精确匹配，取第一个结果（最相关）
    const first = results[0];
    songloft.log.info(`跨平台模糊匹配: "${track.title}" → "${first.title}" (${first.songId})`);
    return first.songId;
  } catch (e) {
    songloft.log.warn(`跨平台搜索失败: "${keyword}" - ${String(e)}`);
    return null;
  }
}

/**
 * 获取曲目的音乐 URL（自动处理跨平台匹配）
 *
 * 流程：
 * 1. 如果歌单平台有对应的洛雪来源且与默认搜索来源相同，直接使用 songId
 * 2. 如果歌单平台有对应的洛雪来源但与默认搜索来源不同，先尝试原始来源，失败后跨平台搜索
 * 3. 如果歌单平台无对应洛雪来源（如汽水音乐），直接跨平台搜索
 *
 * @param config 插件配置
 * @param track 曲目信息
 * @returns 洛雪音源结果
 */
export async function resolveTrackUrl(
  config: PluginConfig,
  track: TrackInfo
): Promise<LuoxueResult | null> {
  const trackSource = PLATFORM_TO_LX[track.platform];
  const targetSource = config.defaultSearchSource;

  // 如果平台无直接对应的洛雪来源（如汽水音乐），直接跨平台搜索
  if (!trackSource) {
    songloft.log.info(`无直接音源映射，跨平台搜索: ${track.title}`);
    const matchedId = await crossPlatformMatch(track, targetSource);
    if (!matchedId) {
      songloft.log.warn(`无法匹配曲目: ${track.title} - ${track.artist}`);
      return null;
    }
    const url = await getMusicUrl(config, targetSource, matchedId, config.defaultQuality);
    if (!url) return null;
    return {
      url,
      source: targetSource,
      songId: matchedId,
      quality: config.defaultQuality,
      matched: true,
    };
  }

  let source = targetSource;
  let songId = track.platformSongId;

  // 如果歌单平台对应的洛雪来源就是默认搜索来源，直接使用
  if (trackSource === targetSource) {
    songloft.log.info(`同平台直接获取: ${track.title} (${source}/${songId})`);
  } else {
    // 跨平台：先尝试用原始平台来源获取
    const directUrl = await getMusicUrl(config, trackSource, songId, config.defaultQuality);
    if (directUrl) {
      return {
        url: directUrl,
        source: trackSource,
        songId,
        quality: config.defaultQuality,
        matched: false,
      };
    }

    // 原始来源获取失败，进行跨平台搜索
    const matchedId = await crossPlatformMatch(track, targetSource);
    if (!matchedId) {
      songloft.log.warn(`无法匹配曲目: ${track.title} - ${track.artist}`);
      return null;
    }
    songId = matchedId;
    source = targetSource;
  }

  // 获取下载 URL
  const url = await getMusicUrl(config, source, songId, config.defaultQuality);
  if (!url) {
    return null;
  }

  return {
    url,
    source,
    songId,
    quality: config.defaultQuality,
    matched: source !== trackSource,
  };
}

/**
 * 测试洛雪音源服务器连通性
 */
export async function testLuoxueServer(config: PluginConfig): Promise<{ ok: boolean; message: string }> {
  if (!config.luoxueApiUrl) {
    return { ok: false, message: '未配置洛雪音源 API 地址' };
  }

  try {
    const base = config.luoxueApiUrl.replace(/\/+$/, '');
    const resp = await fetchWithTimeout(base, {
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0' },
    }, 8000);

    if (resp.status === 200) {
      return { ok: true, message: '洛雪音源服务器连接正常' };
    }
    return { ok: false, message: `服务器回应状态码: ${resp.status}` };
  } catch (e) {
    return { ok: false, message: `连接失败: ${String(e)}` };
  }
}
