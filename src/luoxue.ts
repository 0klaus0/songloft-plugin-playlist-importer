/**
 * 洛雪音源客户端 — 获取音乐下载链接
 *
 * 支持三种音源模式（按优先级）：
 * 1. 自定义音源脚本：通过 songloft.jsenv 加载用户提供的洛雪音源脚本（.js），直接解析 URL
 * 2. 外部洛雪 API：通过配置的 API 服务器获取（lx-source / lx-music-api-server 等）
 * 3. 内置音源：通过 sourceData 将信息传递给 Songloft 内置音源解析
 *
 * 同时提供跨平台搜索匹配功能：当歌单来源平台与洛雪音源平台不一致时，
 * 通过搜索目标平台找到对应歌曲 ID，再获取下载链接。
 */
/// <reference types="@songloft/plugin-sdk" />
import { PluginConfig, TrackInfo, LXSource, PLATFORM_TO_LX, SearchResult } from './types';
import { fetchWithTimeout } from './utils';
import { searchMusic as searchOnPlatform } from './fetchers';
import { resolveUrlWithCustomSource } from './lx-source';
import { logInfo, logWarn, logError } from './logger';

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
  logInfo(`洛雪音源请求: ${url}`);

  try {
    const resp = await fetchWithTimeout(url, {
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0' },
    }, 15000);

    if (resp.status !== 200) {
      logWarn(`洛雪音源回应状态码: ${resp.status}`);
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
      logWarn(`洛雪音源回应错误: code=${data.code}, msg=${data.msg || data.message || ''}`);
      return null;
    }
    // 格式4: { "link": "http://..." }
    if (data.link && typeof data.link === 'string') {
      return data.link as string;
    }

    logWarn('洛雪音源回应中未找到有效的 URL');
    return null;
  } catch (e) {
    logError(`洛雪音源请求失败: ${String(e)}`);
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
  logInfo(`跨平台搜索: "${keyword}" on ${targetSource}`);

  try {
    const results: SearchResult[] = await searchOnPlatform(keyword, targetSource, 5);
    if (results.length === 0) {
      logWarn(`跨平台搜索无结果: "${keyword}"`);
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
        logInfo(`跨平台匹配成功: "${track.title}" → "${r.title}" (${r.songId})`);
        return r.songId;
      }
    }

    // 如果没有精确匹配，取第一个结果（最相关）
    const first = results[0];
    logInfo(`跨平台模糊匹配: "${track.title}" → "${first.title}" (${first.songId})`);
    return first.songId;
  } catch (e) {
    logWarn(`跨平台搜索失败: "${keyword}" - ${String(e)}`);
    return null;
  }
}

/**
 * 获取曲目的音乐 URL（自动处理跨平台匹配和多种音源模式）
 *
 * 优先级：
 * 1. 自定义音源脚本：通过 songloft.jsenv 加载用户提供的脚本解析 URL
 * 2. 外部洛雪 API：通过配置的 API 服务器获取
 * 3. 返回 null（由调用方回退到 sourceData 内置音源模式）
 *
 * 跨平台匹配逻辑：
 * - 如果歌单平台有对应的洛雪来源，直接使用原始 songId
 * - 如果歌单平台无对应洛雪来源（如汽水音乐），跨平台搜索匹配
 *
 * @param config 插件配置
 * @param track 曲目信息
 * @returns 洛雪音源结果（包含直接 URL），或 null
 */
export async function resolveTrackUrl(
  config: PluginConfig,
  track: TrackInfo
): Promise<LuoxueResult | null> {
  const customUrls = (config.customSourceUrls || [])
    .map(u => u.trim())
    .filter(u => u.length > 0);
  const hasExternalApi = !config.useBuiltinSource && config.luoxueApiUrl;

  // 既没有自定义音源脚本，也没有外部 API，返回 null（使用 sourceData）
  if (customUrls.length === 0 && !hasExternalApi) {
    logInfo(`无可用音源，将使用 sourceData: ${track.title}`);
    return null;
  }

  const trackSource = PLATFORM_TO_LX[track.platform];
  const targetSource = config.defaultSearchSource;

  // 确定音源来源和歌曲 ID
  let source: LXSource;
  let songId: string;

  if (trackSource) {
    // 平台有直接对应的洛雪来源
    source = trackSource;
    songId = track.platformSongId;
    logInfo(`直接音源映射: ${track.title} → ${source}/${songId}`);
  } else {
    // 平台无直接对应（如汽水音乐），跨平台搜索
    logInfo(`跨平台搜索匹配: ${track.title}`);
    const matchedId = await crossPlatformMatch(track, targetSource);
    if (!matchedId) {
      logWarn(`无法匹配曲目: ${track.title} - ${track.artist}`);
      return null;
    }
    source = targetSource;
    songId = matchedId;
  }

  // 优先级 1：自定义音源脚本
  if (customUrls.length > 0) {
    logInfo(`使用自定义音源脚本解析: ${source}/${songId} (音质=${config.defaultQuality})`);
    const url = await resolveUrlWithCustomSource(customUrls, source, songId, config.defaultQuality);
    if (url) {
      logInfo(`自定义音源脚本解析成功: ${source}/${songId} → ${url.substring(0, 80)}...`);
      return {
        url,
        source,
        songId,
        quality: config.defaultQuality,
        matched: !trackSource || source !== trackSource,
      };
    }
    logWarn(`自定义音源脚本解析失败: ${source}/${songId}`);
  }

  // 优先级 2：外部洛雪 API
  if (hasExternalApi) {
    // 如果原始来源与默认搜索来源不同，先尝试原始来源
    if (trackSource && trackSource !== targetSource) {
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
      // 原始来源失败，尝试跨平台搜索后用默认来源
      const matchedId = await crossPlatformMatch(track, targetSource);
      if (matchedId) {
        const url = await getMusicUrl(config, targetSource, matchedId, config.defaultQuality);
        if (url) {
          return {
            url,
            source: targetSource,
            songId: matchedId,
            quality: config.defaultQuality,
            matched: true,
          };
        }
      }
    } else {
      const url = await getMusicUrl(config, source, songId, config.defaultQuality);
      if (url) {
        return {
          url,
          source,
          songId,
          quality: config.defaultQuality,
          matched: !trackSource || source !== trackSource,
        };
      }
    }
  }

  // 所有音源都失败，返回 null（调用方回退到 sourceData）
  logInfo(`所有音源解析失败，将使用 sourceData: ${track.title}`);
  return null;
}

/**
 * 为曲目生成 sourceData（用于 Songloft 内置音源回退模式）
 *
 * 当自定义音源脚本和外部 API 都无法解析 URL 时，通过 sourceData
 * 将平台和歌曲 ID 信息传递给 Songloft，由内置音源自动解析。
 *
 * @param track 曲目信息
 * @param config 插件配置
 * @returns sourceData JSON 字符串，或 null（无法生成时）
 */
export async function generateSourceData(
  track: TrackInfo,
  config: PluginConfig
): Promise<string | null> {
  const trackSource = PLATFORM_TO_LX[track.platform];
  const targetSource = config.defaultSearchSource;

  // 如果平台有直接对应的洛雪来源，直接使用原始 songId
  if (trackSource) {
    const sourceData = {
      source: trackSource,
      id: track.platformSongId,
      quality: config.defaultQuality,
      title: track.title,
      artist: track.artist,
    };
    logInfo(`生成 sourceData: ${track.title} → ${trackSource}/${track.platformSongId}`);
    return JSON.stringify(sourceData);
  }

  // 平台无直接对应（如汽水音乐），跨平台搜索匹配
  logInfo(`跨平台搜索生成 sourceData: ${track.title}`);
  const matchedId = await crossPlatformMatch(track, targetSource);
  if (!matchedId) {
    logWarn(`无法匹配曲目: ${track.title} - ${track.artist}`);
    return null;
  }

  const sourceData = {
    source: targetSource,
    id: matchedId,
    quality: config.defaultQuality,
    title: track.title,
    artist: track.artist,
  };
  return JSON.stringify(sourceData);
}

/**
 * 测试音源连通性
 *
 * 优先测试自定义音源脚本（通过 jsenv 实际加载并初始化），
 * 其次测试外部洛雪 API 服务器连通性。
 */
export async function testLuoxueServer(config: PluginConfig): Promise<{ ok: boolean; message: string }> {
  const customUrls = (config.customSourceUrls || [])
    .map(u => u.trim())
    .filter(u => u.length > 0);

  // 优先测试自定义音源脚本（实际加载并初始化）
  if (customUrls.length > 0) {
    const { testCustomSources } = await import('./lx-source');
    return await testCustomSources(customUrls);
  }

  // 测试外部洛雪 API
  if (config.luoxueApiUrl) {
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

  return { ok: true, message: '使用 Songloft 内置音源' };
}
