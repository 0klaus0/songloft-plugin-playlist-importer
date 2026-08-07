/**
 * Songloft API 客戶端 — 通過 REST API 與 Songloft 伺服器互動
 *
 * 功能：
 * - 建立歌單
 * - 搜尋/新增歌曲
 * - 將歌曲加入歌單
 * - 下載檔案到音樂目錄
 */
import { TrackInfo, PlaylistInfo, ImportProgress } from './types';
import { fetchWithTimeout, sanitizeFilename, sleep } from './utils';
import { resolveTrackUrl } from './luoxue';
import { PluginConfig } from './types';

/** 快取的認證資訊 */
let cachedToken: string | null = null;
let cachedHostUrl: string | null = null;

/**
 * 取得 JWT Token（帶快取）
 */
async function getToken(): Promise<string> {
  if (cachedToken) return cachedToken;
  cachedToken = await songloft.plugin.getToken();
  return cachedToken;
}

/**
 * 取得基礎 URL（帶快取）
 */
async function getHostUrl(): Promise<string> {
  if (cachedHostUrl) return cachedHostUrl;
  cachedHostUrl = await songloft.plugin.getHostUrl();
  return cachedHostUrl.replace(/\/+$/, '');
}

/**
 * 呼叫 Songloft REST API
 */
async function songloftApi(
  path: string,
  method = 'GET',
  body?: unknown
): Promise<{ status: number; data: unknown }> {
  const host = await getHostUrl();
  const token = await getToken();
  const url = `${host}${path}`;

  const options: Record<string, unknown> = {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  };
  if (body !== undefined) {
    options.body = JSON.stringify(body);
  }

  const resp = await fetchWithTimeout(url, options, 15000);
  let data: unknown = null;
  try {
    data = JSON.parse(resp.body);
  } catch { /* 非 JSON 回應 */ }

  return { status: resp.status, data };
}

// ==================== 歌單操作 ====================

/**
 * 建立新歌單
 */
export async function createPlaylist(name: string): Promise<number> {
  const resp = await songloftApi('/api/v1/playlists', 'POST', {
    name,
    type: 'normal',
  });

  if (resp.status !== 200 && resp.status !== 201) {
    throw new Error(`建立歌單失敗: HTTP ${resp.status}`);
  }

  const data = resp.data as Record<string, unknown>;
  // 嘗試多種回應格式
  const playlist = data.playlist || data.data || data;
  const id = (playlist as Record<string, unknown>)?.id || data.id;
  if (!id) {
    throw new Error('建立歌單成功但未取得歌單 ID');
  }
  return Number(id);
}

/**
 * 取得所有歌單
 */
export async function listPlaylists(): Promise<Record<string, unknown>[]> {
  const resp = await songloftApi('/api/v1/playlists');
  if (resp.status !== 200) return [];

  const data = resp.data as Record<string, unknown>;
  const playlists = data.playlists || data.data || data.items || data;
  return Array.isArray(playlists) ? playlists : [];
}

/**
 * 將歌曲加入歌單
 */
export async function addSongsToPlaylist(
  playlistId: number,
  songIds: number[]
): Promise<void> {
  const resp = await songloftApi(`/api/v1/playlists/${playlistId}/songs`, 'POST', {
    song_ids: songIds,
  });

  if (resp.status !== 200 && resp.status !== 201) {
    throw new Error(`加入歌單失敗: HTTP ${resp.status}`);
  }
}

// ==================== 歌曲操作 ====================

/**
 * 搜尋曲庫中已有的歌曲
 */
export async function searchExistingSongs(
  keyword: string,
  pageSize = 20
): Promise<Record<string, unknown>[]> {
  const resp = await songloftApi(
    `/api/v1/songs?search=${encodeURIComponent(keyword)}&page=1&page_size=${pageSize}`
  );
  if (resp.status !== 200) return [];

  const data = resp.data as Record<string, unknown>;
  const songs = data.songs || data.data || data.items || data;
  return Array.isArray(songs) ? songs : [];
}

/**
 * 嘗試在曲庫中匹配曲目
 */
export async function findExistingSong(
  track: TrackInfo
): Promise<number | null> {
  // 使用標題搜尋
  const results = await searchExistingSongs(track.title, 10);
  if (results.length === 0) return null;

  // 嘗試精確匹配標題 + 藝術家
  for (const song of results) {
    const title = String(song.title || song.name || '').toLowerCase();
    const artist = String(song.artist || song.singer || '').toLowerCase();

    const titleMatch = title === track.title.toLowerCase() ||
      title.includes(track.title.toLowerCase()) ||
      track.title.toLowerCase().includes(title);
    const artistMatch = artist === '' ||
      artist.includes(track.artist.toLowerCase()) ||
      track.artist.toLowerCase().includes(artist) ||
      track.artist === '未知藝術家';

    if (titleMatch && artistMatch) {
      return Number(song.id);
    }
  }

  return null;
}

/**
 * 嘗試新增一首遠端歌曲到曲庫
 *
 * 嘗試多種 API 端點格式，因為 Songloft API 版本可能不同。
 */
export async function addRemoteSong(
  title: string,
  artist: string,
  url: string,
  album?: string,
  duration?: number
): Promise<number | null> {
  const songData: Record<string, unknown> = {
    type: 'remote',
    title,
    artist,
    url,
    album: album || '',
    duration: duration || 0,
  };

  // 嘗試 POST /api/v1/songs
  const resp = await songloftApi('/api/v1/songs', 'POST', songData);
  if (resp.status === 200 || resp.status === 201) {
    const data = resp.data as Record<string, unknown>;
    const song = data.song || data.data || data;
    const id = (song as Record<string, unknown>)?.id || data.id;
    if (id) return Number(id);
  }

  // 嘗試 POST /api/v1/songs/remote
  const resp2 = await songloftApi('/api/v1/songs/remote', 'POST', songData);
  if (resp2.status === 200 || resp2.status === 201) {
    const data = resp2.data as Record<string, unknown>;
    const song = data.song || data.data || data;
    const id = (song as Record<string, unknown>)?.id || data.id;
    if (id) return Number(id);
  }

  songloft.log.warn(`無法通過 API 新增遠端歌曲: ${title}`);
  return null;
}

// ==================== 匯入流程 ====================

/**
 * 下載模式：下載音樂檔案到本地音樂目錄
 *
 * 通過洛雪音源獲取 URL，下載檔案並保存到音樂目錄。
 * 下載完成後需要手動重新掃描音樂庫。
 */
async function downloadTrack(
  config: PluginConfig,
  track: TrackInfo,
  progress: ImportProgress
): Promise<boolean> {
  // 通過洛雪音源獲取下載 URL
  const result = await resolveTrackUrl(config, track);
  if (!result || !result.url) {
    progress.errors.push(`無法獲取下載連結: ${track.title} - ${track.artist}`);
    return false;
  }

  // 下載檔案
  try {
    const downloadResp = await fetchWithTimeout(result.url, {
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0' },
    }, 60000);

    if (downloadResp.status !== 200) {
      progress.errors.push(`下載失敗 (${downloadResp.status}): ${track.title}`);
      return false;
    }

    // 嘗試通過插件 API 寫入檔案到音樂目錄
    const filename = sanitizeFilename(`${track.artist} - ${track.title}`) + '.mp3';
    const musicPath = `/music/${filename}`;

    // 嘗試使用 fs:music 權限寫入
    try {
      // 方法1: 通過 songloft.fs API（如果存在）
      const fsApi = (songloft as unknown as Record<string, unknown>).fs as
        Record<string, (path: string, content: string) => Promise<unknown>> | undefined;
      if (fsApi && typeof fsApi.write === 'function') {
        await fsApi.write(musicPath, downloadResp.body);
        songloft.log.info(`已下載: ${filename}`);
        progress.importedSongs++;
        return true;
      }
    } catch (e) {
      songloft.log.warn(`fs.write 失敗: ${String(e)}`);
    }

    // 方法2: 通過 REST API 上傳（如果存在端點）
    try {
      const host = await getHostUrl();
      const token = await getToken();
      const uploadResp = await fetchWithTimeout(
        `${host}/api/v1/songs/upload`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'audio/mpeg',
            'X-Filename': encodeURIComponent(filename),
          },
          body: downloadResp.body,
        },
        30000
      );
      if (uploadResp.status === 200 || uploadResp.status === 201) {
        songloft.log.info(`已上傳: ${filename}`);
        progress.importedSongs++;
        return true;
      }
    } catch (e) {
      songloft.log.warn(`上傳失敗: ${String(e)}`);
    }

    // 方法3: 保存 URL 到 storage 作為後備
    progress.errors.push(
      `檔案系統寫入不可用，已獲取 URL 但無法保存: ${track.title}`
    );
    return false;
  } catch (e) {
    progress.errors.push(`下載異常: ${track.title} - ${String(e)}`);
    return false;
  }
}

/**
 * 串流模式：獲取串流 URL 並作為遠端歌曲匯入
 */
async function streamTrack(
  config: PluginConfig,
  track: TrackInfo,
  progress: ImportProgress
): Promise<number | null> {
  // 通過洛雪音源獲取串流 URL
  const result = await resolveTrackUrl(config, track);
  if (!result || !result.url) {
    progress.errors.push(`無法獲取串流連結: ${track.title} - ${track.artist}`);
    return null;
  }

  // 新增為遠端歌曲
  const songId = await addRemoteSong(
    track.title,
    track.artist,
    result.url,
    track.album,
    track.duration
  );

  if (songId) {
    progress.importedSongs++;
    return songId;
  }

  progress.errors.push(`無法新增遠端歌曲: ${track.title}`);
  return null;
}

/**
 * 執行歌單匯入
 *
 * @param playlist 來源歌單資訊
 * @param config 插件配置
 * @param progress 進度回呼（會被直接修改）
 * @returns 匯入的歌單 ID
 */
export async function importPlaylist(
  playlist: PlaylistInfo,
  config: PluginConfig,
  progress: ImportProgress
): Promise<number | null> {
  progress.status = 'importing';
  progress.total = playlist.tracks.length;
  progress.current = 0;
  progress.importedSongs = 0;
  progress.errors = [];

  // 建立 Songloft 歌單
  const playlistName = `[匯入] ${playlist.name}`;
  songloft.log.info(`建立 Songloft 歌單: ${playlistName}`);
  let playlistId: number;
  try {
    playlistId = await createPlaylist(playlistName);
  } catch (e) {
    progress.status = 'error';
    progress.message = `建立歌單失敗: ${String(e)}`;
    return null;
  }

  // 逐一處理曲目
  const collectedSongIds: number[] = [];
  const batchDelay = 300; // 每首歌之間延遲，避免請求過快

  for (let i = 0; i < playlist.tracks.length; i++) {
    const track = playlist.tracks[i];
    progress.current = i + 1;
    progress.currentTrack = `${track.title} - ${track.artist}`;
    progress.status = config.importMode === 'download' ? 'downloading' : 'importing';

    songloft.log.info(`處理曲目 ${i + 1}/${playlist.tracks.length}: ${track.title}`);

    try {
      // 步驟 1：先檢查曲庫中是否已有此歌曲
      const existingId = await findExistingSong(track);
      if (existingId) {
        songloft.log.info(`曲庫已有此歌曲: ${track.title} (id=${existingId})`);
        collectedSongIds.push(existingId);
        progress.importedSongs++;
      } else if (config.importMode === 'download') {
        // 下載模式
        await downloadTrack(config, track, progress);
      } else {
        // 串流模式
        const songId = await streamTrack(config, track, progress);
        if (songId) {
          collectedSongIds.push(songId);
        }
      }
    } catch (e) {
      progress.errors.push(`處理失敗: ${track.title} - ${String(e)}`);
    }

    // 批次加入歌單（每 10 首或最後一首）
    if ((collectedSongIds.length > 0 && collectedSongIds.length % 10 === 0) ||
        (i === playlist.tracks.length - 1 && collectedSongIds.length > 0)) {
      try {
        const batch = collectedSongIds.splice(0);
        await addSongsToPlaylist(playlistId, batch);
        songloft.log.info(`已加入 ${batch.length} 首到歌單`);
      } catch (e) {
        songloft.log.warn(`批次加入歌單失敗: ${String(e)}`);
      }
    }

    // 延遲，避免請求過快被封
    if (i < playlist.tracks.length - 1) {
      await sleep(batchDelay);
    }
  }

  progress.status = 'done';
  progress.message = `匯入完成：成功 ${progress.importedSongs}/${progress.total} 首` +
    (progress.errors.length > 0 ? `，失敗 ${progress.errors.length} 首` : '');

  songloft.log.info(progress.message);
  return playlistId;
}
