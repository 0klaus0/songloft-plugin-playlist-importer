/**
 * Songloft API 客户端 — 使用 songloft SDK API 与宿主交互
 *
 * 功能：
 * - 创建歌单（songloft.playlists.create）
 * - 搜索曲库已有歌曲（songloft.songs.search）
 * - 创建远程歌曲（songloft.songs.create）
 * - 下载歌曲到本地（songloft.songs.download）
 * - 将歌曲加入歌单（songloft.playlists.addSongs）
 *
 * 支持两种音源模式：
 * - 外部洛雪 API：通过配置的 API 服务器获取音乐 URL
 * - 内置音源模式：通过 sourceData 将平台信息传递给 Songloft，由内置洛雪音源解析
 */
/// <reference types="@songloft/plugin-sdk" />
import { TrackInfo, PlaylistInfo, ImportProgress, PluginConfig } from './types';
import { sleep } from './utils';
import { resolveTrackUrl, generateSourceData } from './luoxue';
import { logInfo, logWarn, logError } from './logger';

// ==================== 歌单操作 ====================

/**
 * 创建新歌单
 */
async function createPlaylist(name: string): Promise<number> {
  const playlist = await songloft.playlists.create({
    name,
    type: 'normal',
  });
  logInfo(`已创建歌单: ${name} (id=${playlist.id})`);
  return playlist.id;
}

/**
 * 将歌曲加入歌单
 */
async function addSongsToPlaylist(
  playlistId: number,
  songIds: number[]
): Promise<void> {
  const result = await songloft.playlists.addSongs(playlistId, songIds);
  logInfo(`已加入 ${result.added} 首到歌单（跳过 ${result.skipped} 首）`);
}

// ==================== 歌曲操作 ====================

/**
 * 在曲库中搜索已有歌曲
 */
async function findExistingSong(track: TrackInfo): Promise<number | null> {
  try {
    const keyword = `${track.title} ${track.artist}`.trim();
    const songs = await songloft.songs.search(keyword);

    for (const song of songs) {
      const title = (song.title || '').toLowerCase();
      const artist = (song.artist || '').toLowerCase();
      const trackTitle = track.title.toLowerCase();
      const trackArtist = track.artist.toLowerCase();

      const titleMatch = title === trackTitle ||
        title.includes(trackTitle) ||
        trackTitle.includes(title);
      const artistMatch = artist === '' ||
        artist.includes(trackArtist) ||
        trackArtist.includes(artist) ||
        track.artist === '未知艺术家';

      if (titleMatch && artistMatch) {
        return song.id;
      }
    }
  } catch (e) {
    logWarn('搜索曲库失败: ' + String(e));
  }
  return null;
}

/**
 * 创建远程歌曲到曲库（带 URL）
 *
 * 使用 songloft.songs.create() 批量创建远程歌曲，
 * 歌曲会自动关联到当前插件。
 */
async function createRemoteSong(
  track: TrackInfo,
  url: string
): Promise<number | null> {
  try {
    const songs = await songloft.songs.create([{
      url,
      title: track.title,
      artist: track.artist || '未知艺术家',
      album: track.album || '',
      duration: track.duration || 0,
    }]);

    if (songs && songs.length > 0 && songs[0].id) {
      logInfo(`已创建远程歌曲: ${track.title} (id=${songs[0].id})`);
      return songs[0].id;
    }
  } catch (e) {
    logWarn(`创建远程歌曲失败: ${track.title} - ${String(e)}`);
  }
  return null;
}

/**
 * 使用 sourceData 创建歌曲（内置音源模式）
 *
 * 不提供 url，而是通过 sourceData 将平台和歌曲 ID 信息
 * 传递给 Songloft，由内置洛雪音源在播放/下载时自动解析 URL。
 */
async function createSongWithSourceData(
  track: TrackInfo,
  sourceData: string
): Promise<number | null> {
  try {
    const songs = await songloft.songs.create([{
      title: track.title,
      artist: track.artist || '未知艺术家',
      album: track.album || '',
      duration: track.duration || 0,
      sourceData,
    }]);

    if (songs && songs.length > 0 && songs[0].id) {
      logInfo(`已创建歌曲（内置音源）: ${track.title} (id=${songs[0].id})`);
      return songs[0].id;
    }
  } catch (e) {
    logWarn(`创建歌曲失败（内置音源）: ${track.title} - ${String(e)}`);
  }
  return null;
}

// ==================== 导入流程 ====================

/**
 * 串流模式：获取串流 URL 并作为远程歌曲导入
 *
 * 优先使用自定义音源脚本或外部 API 解析直接 URL。
 * 如果配置了音源但解析失败，报告错误（不创建无法播放的歌曲）。
 * 如果未配置任何音源，回退到 sourceData 内置音源模式。
 */
async function streamTrack(
  config: PluginConfig,
  track: TrackInfo,
  progress: ImportProgress
): Promise<number | null> {
  const hasCustomSource = (config.customSourceUrls || []).some(u => u.trim().length > 0);
  const hasExternalApi = config.luoxueApiUrl && !config.useBuiltinSource;

  // 尝试解析直接 URL（自定义音源脚本 → 外部 API）
  const result = await resolveTrackUrl(config, track);
  if (result && result.url) {
    const songId = await createRemoteSong(track, result.url);
    if (songId) {
      progress.importedSongs++;
      return songId;
    }
    progress.errors.push(`无法创建歌曲: ${track.title}`);
    return null;
  }

  // 配置了音源但解析失败 → 报告错误，不创建无法播放的歌曲
  if (hasCustomSource || hasExternalApi) {
    logWarn(`音源解析失败，跳过: ${track.title}`);
    progress.errors.push(`音源解析失败: ${track.title} - ${track.artist}`);
    return null;
  }

  // 未配置任何音源，回退到 sourceData
  logInfo(`无音源配置，使用 sourceData: ${track.title}`);
  const sourceData = await generateSourceData(track, config);
  if (!sourceData) {
    progress.errors.push(`无法匹配曲目: ${track.title} - ${track.artist}`);
    return null;
  }

  const songId = await createSongWithSourceData(track, sourceData);
  if (songId) {
    progress.importedSongs++;
    return songId;
  }

  progress.errors.push(`无法创建歌曲: ${track.title}`);
  return null;
}

/**
 * 下载模式：获取 URL，创建远程歌曲后下载到本地
 *
 * 优先使用自定义音源脚本或外部 API 解析直接 URL，然后下载到本地。
 * 如果配置了音源但解析失败，报告错误（不创建无法播放的歌曲）。
 * 如果未配置任何音源，回退到 sourceData 模式。
 * 下载失败时歌曲仍以串流形式保留在曲库中。
 */
async function downloadTrack(
  config: PluginConfig,
  track: TrackInfo,
  progress: ImportProgress
): Promise<number | null> {
  const hasCustomSource = (config.customSourceUrls || []).some(u => u.trim().length > 0);
  const hasExternalApi = config.luoxueApiUrl && !config.useBuiltinSource;

  let songId: number | null = null;

  // 尝试解析直接 URL（自定义音源脚本 → 外部 API）
  const result = await resolveTrackUrl(config, track);
  if (result && result.url) {
    songId = await createRemoteSong(track, result.url);
  }

  // 直接 URL 解析失败
  if (!songId) {
    // 配置了音源但解析失败 → 报告错误，不创建无法播放的歌曲
    if (hasCustomSource || hasExternalApi) {
      logWarn(`音源解析失败，跳过: ${track.title}`);
      progress.errors.push(`音源解析失败: ${track.title} - ${track.artist}`);
      return null;
    }

    // 未配置任何音源，回退到 sourceData
    logInfo(`无音源配置，使用 sourceData: ${track.title}`);
    const sourceData = await generateSourceData(track, config);
    if (!sourceData) {
      progress.errors.push(`无法匹配曲目: ${track.title} - ${track.artist}`);
      return null;
    }

    songId = await createSongWithSourceData(track, sourceData);
  }

  if (!songId) {
    progress.errors.push(`无法创建歌曲: ${track.title}`);
    return null;
  }

  // 尝试下载到本地
  let downloadSuccess = false;
  try {
    const downloadResult = await songloft.songs.download(songId);
    if (downloadResult.status === 'ok' || downloadResult.status === 'done') {
      logInfo(`已下载: ${track.title} → ${downloadResult.path}`);
      downloadSuccess = true;
    } else if (downloadResult.error) {
      logInfo(`下载未成功，已作为串流歌曲保留: ${track.title} - ${downloadResult.error}`);
    }
  } catch (e) {
    logInfo(`下载未成功，已作为串流歌曲保留: ${track.title} - ${String(e)}`);
  }

  if (downloadSuccess) {
    progress.downloadedSongs++;
  } else {
    progress.streamingSongs++;
  }
  progress.importedSongs++;
  return songId;
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
  progress.streamingSongs = 0;
  progress.downloadedSongs = 0;
  progress.errors = [];

  // 创建 Songloft 歌单
  const playlistName = `[导入] ${playlist.name}`;
  logInfo(`创建 Songloft 歌单: ${playlistName}`);
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

    logInfo(`处理曲目 ${i + 1}/${playlist.tracks.length}: ${track.title}`);

    try {
      // 步骤 1：先检查曲库中是否已有此歌曲
      const existingId = await findExistingSong(track);
      if (existingId) {
        logInfo(`曲库已有此歌曲: ${track.title} (id=${existingId})`);
        collectedSongIds.push(existingId);
        progress.importedSongs++;
      } else if (config.importMode === 'download') {
        // 下载模式
        const songId = await downloadTrack(config, track, progress);
        if (songId) {
          collectedSongIds.push(songId);
        }
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
      } catch (e) {
        logWarn(`批次加入歌单失败: ${String(e)}`);
      }
    }

    // 延迟，避免请求过快被封
    if (i < playlist.tracks.length - 1) {
      await sleep(batchDelay);
    }
  }

  progress.status = 'done';
  let msg = `导入完成：成功 ${progress.importedSongs}/${progress.total} 首`;
  if (progress.downloadedSongs > 0) {
    msg += `（已下载 ${progress.downloadedSongs} 首`;
    if (progress.streamingSongs > 0) {
      msg += `，串流 ${progress.streamingSongs} 首`;
    }
    msg += '）';
  } else if (progress.streamingSongs > 0) {
    msg += `（串流 ${progress.streamingSongs} 首）`;
  }
  if (progress.errors.length > 0) {
    msg += `，失败 ${progress.errors.length} 首`;
  }
  progress.message = msg;

  logInfo(progress.message);
  return playlistId;
}
