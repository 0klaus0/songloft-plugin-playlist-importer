/**
 * Songloft API 客户端 — 通过 REST API 与 Songloft 服务器交互
 *
 * 功能：
 * - 创建歌单
 * - 搜索/新增歌曲
 * - 将歌曲加入歌单
 * - 下载文件到音乐目录
 */
import { TrackInfo, PlaylistInfo, ImportProgress } from './types';
import { fetchWithTimeout, sanitizeFilename, sleep } from './utils';
import { resolveTrackUrl } from './luoxue';
import { PluginConfig } from './types';

/** 缓存的认证信息 */
let cachedToken: string | null = null;
let cachedHostUrl: string | null = null;

/**
 * 取得 JWT Token（带缓存）
 */
async function getToken(): Promise<string> {
  if (cachedToken) return cachedToken;
  cachedToken = await songloft.plugin.getToken();
  return cachedToken;
}

/**
 * 取得基础 URL（带缓存）
 */
async function getHostUrl(): Promise<string> {
  if (cachedHostUrl) return cachedHostUrl;
  cachedHostUrl = await songloft.plugin.getHostUrl();
  return cachedHostUrl.replace(/\/+$/, '');
}

/**
 * 调用 Songloft REST API
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
  } catch { /* 非 JSON 回应 */ }

  return { status: resp.status, data };
}

// ==================== 歌单操作 ====================

/**
 * 创建新歌单
 */
export async function createPlaylist(name: string): Promise<number> {
  const resp = await songloftApi('/api/v1/playlists', 'POST', {
    name,
    type: 'normal',
  });

  if (resp.status !== 200 && resp.status !== 201) {
    throw new Error(`创建歌单失败: HTTP ${resp.status}`);
  }

  const data = resp.data as Record<string, unknown>;
  // 尝试多种回应格式
  const playlist = data.playlist || data.data || data;
  const id = (playlist as Record<string, unknown>)?.id || data.id;
  if (!id) {
    throw new Error('创建歌单成功但未取得歌单 ID');
  }
  return Number(id);
}

/**
 * 取得所有歌单
 */
export async function listPlaylists(): Promise<Record<string, unknown>[]> {
  const resp = await songloftApi('/api/v1/playlists');
  if (resp.status !== 200) return [];

  const data = resp.data as Record<string, unknown>;
  const playlists = data.playlists || data.data || data.items || data;
  return Array.isArray(playlists) ? playlists : [];
}

/**
 * 将歌曲加入歌单
 */
export async function addSongsToPlaylist(
  playlistId: number,
  songIds: number[]
): Promise<void> {
  const resp = await songloftApi(`/api/v1/playlists/${playlistId}/songs`, 'POST', {
    song_ids: songIds,
  });

  if (resp.status !== 200 && resp.status !== 201) {
    throw new Error(`加入歌单失败: HTTP ${resp.status}`);
  }
}

// ==================== 歌曲操作 ====================

/**
 * 搜索曲库中已有的歌曲
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
 * 尝试在曲库中匹配曲目
 */
export async function findExistingSong(
  track: TrackInfo
): Promise<number | null> {
  // 使用标题搜索
  const results = await searchExistingSongs(track.title, 10);
  if (results.length === 0) return null;

  // 尝试精确匹配标题 + 艺术家
  for (const song of results) {
    const title = String(song.title || song.name || '').toLowerCase();
    const artist = String(song.artist || song.singer || '').toLowerCase();

    const titleMatch = title === track.title.toLowerCase() ||
      title.includes(track.title.toLowerCase()) ||
      track.title.toLowerCase().includes(title);
    const artistMatch = artist === '' ||
      artist.includes(track.artist.toLowerCase()) ||
      track.artist.toLowerCase().includes(artist) ||
      track.artist === '未知艺术家';

    if (titleMatch && artistMatch) {
      return Number(song.id);
    }
  }

  return null;
}

/**
 * 尝试新增一首远程歌曲到曲库
 *
 * 尝试多种 API 端点格式，因为 Songloft API 版本可能不同。
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

  // 尝试 POST /api/v1/songs
  const resp = await songloftApi('/api/v1/songs', 'POST', songData);
  if (resp.status === 200 || resp.status === 201) {
    const data = resp.data as Record<string, unknown>;
    const song = data.song || data.data || data;
    const id = (song as Record<string, unknown>)?.id || data.id;
    if (id) return Number(id);
  }

  // 尝试 POST /api/v1/songs/remote
  const resp2 = await songloftApi('/api/v1/songs/remote', 'POST', songData);
  if (resp2.status === 200 || resp2.status === 201) {
    const data = resp2.data as Record<string, unknown>;
    const song = data.song || data.data || data;
    const id = (song as Record<string, unknown>)?.id || data.id;
    if (id) return Number(id);
  }

  songloft.log.warn(`无法通过 API 新增远程歌曲: ${title}`);
  return null;
}

// ==================== 导入流程 ====================

/**
 * 下载模式：下载音乐文件到本地音乐目录
 *
 * 通过洛雪音源获取 URL，下载文件并保存到音乐目录。
 * 下载完成后需要手动重新扫描音乐库。
 */
async function downloadTrack(
  config: PluginConfig,
  track: TrackInfo,
  progress: ImportProgress
): Promise<boolean> {
  // 通过洛雪音源获取下载 URL
  const result = await resolveTrackUrl(config, track);
  if (!result || !result.url) {
    progress.errors.push(`无法获取下载链接: ${track.title} - ${track.artist}`);
    return false;
  }

  // 下载文件
  try {
    const downloadResp = await fetchWithTimeout(result.url, {
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0' },
    }, 60000);

    if (downloadResp.status !== 200) {
      progress.errors.push(`下载失败 (${downloadResp.status}): ${track.title}`);
      return false;
    }

    // 尝试通过插件 API 写入文件到音乐目录
    const filename = sanitizeFilename(`${track.artist} - ${track.title}`) + '.mp3';
    const musicPath = `/music/${filename}`;

    // 尝试使用 fs:music 权限写入
    try {
      // 方法1: 通过 songloft.fs API（如果存在）
      const fsApi = (songloft as unknown as Record<string, unknown>).fs as
        Record<string, (path: string, content: string) => Promise<unknown>> | undefined;
      if (fsApi && typeof fsApi.write === 'function') {
        await fsApi.write(musicPath, downloadResp.body);
        songloft.log.info(`已下载: ${filename}`);
        progress.importedSongs++;
        return true;
      }
    } catch (e) {
      songloft.log.warn(`fs.write 失败: ${String(e)}`);
    }

    // 方法2: 通过 REST API 上传（如果存在端点）
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
        songloft.log.info(`已上传: ${filename}`);
        progress.importedSongs++;
        return true;
      }
    } catch (e) {
      songloft.log.warn(`上传失败: ${String(e)}`);
    }

    // 方法3: 保存 URL 到 storage 作为后备
    progress.errors.push(
      `文件系统写入不可用，已获取 URL 但无法保存: ${track.title}`
    );
    return false;
  } catch (e) {
    progress.errors.push(`下载异常: ${track.title} - ${String(e)}`);
    return false;
  }
}

/**
 * 串流模式：获取串流 URL 并作为远程歌曲导入
 */
async function streamTrack(
  config: PluginConfig,
  track: TrackInfo,
  progress: ImportProgress
): Promise<number | null> {
  // 通过洛雪音源获取串流 URL
  const result = await resolveTrackUrl(config, track);
  if (!result || !result.url) {
    progress.errors.push(`无法获取串流链接: ${track.title} - ${track.artist}`);
    return null;
  }

  // 新增为远程歌曲
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

  progress.errors.push(`无法新增远程歌曲: ${track.title}`);
  return null;
}

/**
 * 执行歌单导入
 *
 * @param playlist 来源歌单信息
 * @param config 插件配置
 * @param progress 进度回调（会被直接修改）
 * @returns 导入的歌单 ID
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

  // 创建 Songloft 歌单
  const playlistName = `[导入] ${playlist.name}`;
  songloft.log.info(`创建 Songloft 歌单: ${playlistName}`);
  let playlistId: number;
  try {
    playlistId = await createPlaylist(playlistName);
  } catch (e) {
    progress.status = 'error';
    progress.message = `创建歌单失败: ${String(e)}`;
    return null;
  }

  // 逐一处理曲目
  const collectedSongIds: number[] = [];
  const batchDelay = 300; // 每首歌之间延迟，避免请求过快

  for (let i = 0; i < playlist.tracks.length; i++) {
    const track = playlist.tracks[i];
    progress.current = i + 1;
    progress.currentTrack = `${track.title} - ${track.artist}`;
    progress.status = config.importMode === 'download' ? 'downloading' : 'importing';

    songloft.log.info(`处理曲目 ${i + 1}/${playlist.tracks.length}: ${track.title}`);

    try {
      // 步骤 1：先检查曲库中是否已有此歌曲
      const existingId = await findExistingSong(track);
      if (existingId) {
        songloft.log.info(`曲库已有此歌曲: ${track.title} (id=${existingId})`);
        collectedSongIds.push(existingId);
        progress.importedSongs++;
      } else if (config.importMode === 'download') {
        // 下载模式
        await downloadTrack(config, track, progress);
      } else {
        // 串流模式
        const songId = await streamTrack(config, track, progress);
        if (songId) {
          collectedSongIds.push(songId);
        }
      }
    } catch (e) {
      progress.errors.push(`处理失败: ${track.title} - ${String(e)}`);
    }

    // 批次加入歌单（每 10 首或最后一首）
    if ((collectedSongIds.length > 0 && collectedSongIds.length % 10 === 0) ||
        (i === playlist.tracks.length - 1 && collectedSongIds.length > 0)) {
      try {
        const batch = collectedSongIds.splice(0);
        await addSongsToPlaylist(playlistId, batch);
        songloft.log.info(`已加入 ${batch.length} 首到歌单`);
      } catch (e) {
        songloft.log.warn(`批次加入歌单失败: ${String(e)}`);
      }
    }

    // 延迟，避免请求过快被封
    if (i < playlist.tracks.length - 1) {
      await sleep(batchDelay);
    }
  }

  progress.status = 'done';
  progress.message = `导入完成：成功 ${progress.importedSongs}/${progress.total} 首` +
    (progress.errors.length > 0 ? `，失败 ${progress.errors.length} 首` : '');

  songloft.log.info(progress.message);
  return playlistId;
}
