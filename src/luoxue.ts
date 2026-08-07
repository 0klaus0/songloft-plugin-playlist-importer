/**
 * 洛雪音源客戶端 — 通過配置的洛雪音源 API 伺服器獲取音樂下載連結
 *
 * 支援的伺服器類型：
 * - lx-source (Go): GET /link/:source/:songId/:quality
 * - lx-music-api-server (Python): GET /url?source=&id=&quality=
 * - 通用自定義伺服器: GET /url?source=&id=&quality=
 *
 * 同時提供跨平台搜尋匹配功能：當歌單來源平台與洛雪音源平台不一致時，
 * 通過搜尋目標平台找到對應歌曲 ID，再獲取下載連結。
 */
import { PluginConfig, TrackInfo, LXSource, PLATFORM_TO_LX, SearchResult } from './types';
import { fetchWithTimeout, searchMusic as searchOnPlatform } from './fetchers';

/** 洛雪音源獲取結果 */
export interface LuoxueResult {
  url: string;
  source: LXSource;
  songId: string;
  quality: string;
  matched: boolean;
}

/**
 * 構建 API 請求 URL（自動適配不同伺服器格式）
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
 * 通過洛雪音源 API 獲取音樂下載連結
 *
 * @param config 插件配置
 * @param source 音源（kw/kg/tx/wy/mg）
 * @param songId 歌曲 ID
 * @param quality 音質
 */
export async function getMusicUrl(
  config: PluginConfig,
  source: LXSource,
  songId: string,
  quality: string
): Promise<string | null> {
  const url = buildApiUrl(config, source, songId, quality);
  songloft.log.info(`洛雪音源請求: ${url}`);

  try {
    const resp = await fetchWithTimeout(url, {
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0' },
    }, 15000);

    if (resp.status !== 200) {
      songloft.log.warn(`洛雪音源回應狀態碼: ${resp.status}`);
      return null;
    }

    // 嘗試解析 JSON 回應
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(resp.body);
    } catch {
      // 如果不是 JSON，可能直接是 URL
      const trimmed = resp.body.trim();
      if (trimmed.startsWith('http')) return trimmed;
      return null;
    }

    // 不同伺服器格式的回應解析
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
      songloft.log.warn(`洛雪音源回應錯誤: code=${data.code}, msg=${data.msg || data.message || ''}`);
      return null;
    }
    // 格式4: { "link": "http://..." }
    if (data.link && typeof data.link === 'string') {
      return data.link as string;
    }

    songloft.log.warn('洛雪音源回應中未找到有效的 URL');
    return null;
  } catch (e) {
    songloft.log.error(`洛雪音源請求失敗: ${String(e)}`);
    return null;
  }
}

/**
 * 跨平台匹配：在目標音源平台搜尋歌曲，找到對應的 songId
 *
 * 當歌單來源平台與洛雪音源平台不一致時使用。
 * 例如：歌單來自網易雲，但洛雪音源只支援酷我，則在酷我搜尋同名歌曲。
 *
 * @param track 原始曲目資訊
 * @param targetSource 目標音源平台
 * @returns 匹配到的歌曲 ID，若無匹配則回傳 null
 */
export async function crossPlatformMatch(
  track: TrackInfo,
  targetSource: LXSource
): Promise<string | null> {
  // 構建搜尋關鍵字
  const keyword = `${track.title} ${track.artist}`.trim();
  songloft.log.info(`跨平台搜尋: "${keyword}" on ${targetSource}`);

  try {
    const results: SearchResult[] = await searchOnPlatform(keyword, targetSource, 5);
    if (results.length === 0) {
      songloft.log.warn(`跨平台搜尋無結果: "${keyword}"`);
      return null;
    }

    // 嘗試精確匹配
    for (const r of results) {
      const titleMatch = r.title.toLowerCase().includes(track.title.toLowerCase()) ||
        track.title.toLowerCase().includes(r.title.toLowerCase());
      const artistMatch = r.artist.toLowerCase().includes(track.artist.toLowerCase()) ||
        track.artist.toLowerCase().includes(r.artist.toLowerCase()) ||
        track.artist === '未知藝術家';

      if (titleMatch && artistMatch) {
        songloft.log.info(`跨平台匹配成功: "${track.title}" → "${r.title}" (${r.songId})`);
        return r.songId;
      }
    }

    // 如果沒有精確匹配，取第一個結果（最相關）
    const first = results[0];
    songloft.log.info(`跨平台模糊匹配: "${track.title}" → "${first.title}" (${first.songId})`);
    return first.songId;
  } catch (e) {
    songloft.log.warn(`跨平台搜尋失敗: "${keyword}" - ${String(e)}`);
    return null;
  }
}

/**
 * 獲取曲目的音樂 URL（自動處理跨平台匹配）
 *
 * 流程：
 * 1. 如果歌單平台對應的洛雪來源與預設搜尋來源相同，直接使用 songId
 * 2. 如果不同，先在目標平台搜尋匹配歌曲，再用匹配到的 songId 獲取 URL
 *
 * @param config 插件配置
 * @param track 曲目資訊
 * @returns 洛雪音源結果
 */
export async function resolveTrackUrl(
  config: PluginConfig,
  track: TrackInfo
): Promise<LuoxueResult | null> {
  const trackSource = PLATFORM_TO_LX[track.platform];
  const targetSource = config.defaultSearchSource;

  let source = targetSource;
  let songId = track.platformSongId;

  // 如果歌單平台對應的洛雪來源就是預設搜尋來源，直接使用
  if (trackSource === targetSource) {
    songloft.log.info(`同平台直接獲取: ${track.title} (${source}/${songId})`);
  } else {
    // 跨平台：先嘗試用原始平台來源獲取
    // 如果洛雪音源伺服器支援多個來源，原始 songId 可能有效
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

    // 原始來源獲取失敗，進行跨平台搜尋
    const matchedId = await crossPlatformMatch(track, targetSource);
    if (!matchedId) {
      songloft.log.warn(`無法匹配曲目: ${track.title} - ${track.artist}`);
      return null;
    }
    songId = matchedId;
    source = targetSource;
  }

  // 獲取下載 URL
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
 * 測試洛雪音源伺服器連通性
 */
export async function testLuoxueServer(config: PluginConfig): Promise<{ ok: boolean; message: string }> {
  if (!config.luoxueApiUrl) {
    return { ok: false, message: '未配置洛雪音源 API 位址' };
  }

  try {
    const base = config.luoxueApiUrl.replace(/\/+$/, '');
    const resp = await fetchWithTimeout(base, {
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0' },
    }, 8000);

    if (resp.status === 200) {
      return { ok: true, message: '洛雪音源伺服器連接正常' };
    }
    return { ok: false, message: `伺服器回應狀態碼: ${resp.status}` };
  } catch (e) {
    return { ok: false, message: `連接失敗: ${String(e)}` };
  }
}
