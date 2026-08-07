/**
 * Songloft API 客户端 — 使用 songloft SDK API 与宿主交互
 *
 * 功能：
 * - 创建歌单（songloft.playlists.create）
 * - 搜索曲库已有歌曲（songloft.songs.search）
 * - 创建远程歌曲（songloft.songs.create）
 * - 下载歌曲到本地（songloft.songs.download）
 * - 将歌曲加入歌单（songloft.playlists.addSongs）
 */
/// <reference types="@songloft/plugin-sdk" />
import { TrackInfo, PlaylistInfo, ImportProgress, PluginConfig } from './types';
import { sleep } from './utils';
import { resolveTrackUrl } from './luoxue';

// ==================== 歌单操作 ====================

/**
 * 创建新歌单
 */
async function createPlaylist(name: string): Promise<number> {
  const playlist = await songloft.playlists.create({
    name,
    type: 'normal',
  });
  songloft.log.info(`已创建歌单: ${name} (id=${playlist.id})`);
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
  songloft.log.info(`已加入 ${result.added} 首到歌单（跳过 ${result.skipped} 首）`);
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
    songloft.log.warn('搜索曲库失败: ' + String(e));
  }
  return null;
}

/**
 * 创建远程歌曲到曲库
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
      songloft.log.info(`已创建远程歌曲: ${track.title} (id=${songs[0].id})`);
      return songs[0].id;
    }
  } catch (e) {
    songloft.log.warn(`创建远程歌曲失败: ${track.title} - ${String(e)}`);
  }
  return null;
}

// ==================== 导入流程 ====================

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
  const songId = await createRemoteSong(track, result.url);
  if (songId) {
    progress.importedSongs++;
    return songId;
  }

  progress.errors.push(`无法新增远程歌曲: ${track.title}`);
  return null;
}

/**
 * 下载模式：获取 URL，创建远程歌曲后下载到本地
 */
async function downloadTrack(
  config: PluginConfig,
  track: TrackInfo,
  progress: ImportProgress
): Promise<number | null> {
  // 通过洛雪音源获取下载 URL
  const result = await resolveTrackUrl(config, track);
  if (!result || !result.url) {
    progress.errors.push(`无法获取下载链接: ${track.title} - ${track.artist}`);
    return null;
  }

  // 先创建远程歌曲
  const songId = await createRemoteSong(track, result.url);
  if (!songId) {
    progress.errors.push(`无法创建歌曲: ${track.title}`);
    return null;
  }

  // 尝试下载到本地
  try {
    const downloadResult = await songloft.songs.download(songId);
    if (downloadResult.status === 'ok' || downloadResult.status === 'done') {
      songloft.log.info(`已下载: ${track.title} → ${downloadResult.path}`);
    } else if (downloadResult.error) {
      songloft.log.warn(`下载失败但歌曲已创建: ${track.title} - ${downloadResult.error}`);
      progress.errors.push(`下载失败（歌曲已添加为远程）: ${track.title}`);
    }
  } catch (e) {
    songloft.log.warn(`下载异常（歌曲已添加为远程）: ${track.title} - ${String(e)}`);
    progress.errors.push(`下载异常（歌曲已添加为远程）: ${track.title}`);
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
