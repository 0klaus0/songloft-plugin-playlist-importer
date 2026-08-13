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
  if (songIds.length === 0) return;
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
 */
async function streamTrack(
  config: PluginConfig,
  track: TrackInfo,
  progress: ImportProgress
): Promise<number | null> {
  const hasCustomSource = (config.customSources || []).some(s => s.value && s.value.length > 0 && s.enabled !== false) || (config.customSourceUrls || []).some(u => u.trim().length > 0);
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

  // 配置了音源但解析失败 → 回退到内置音源 sourceData，而非整首丢弃
  logWarn(`音源解析失败，回退内置音源: ${track.title}`);
  const sd = await generateSourceData(track, config);
  if (sd) {
    const songId = await createSongWithSourceData(track, sd);
    if (songId) {
      progress.importedSongs++;
      return songId;
    }
  }
  progress.errors.push(`音源解析失败: ${track.title} - ${track.artist}`);
  return null;

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
 */
async function downloadTrack(
  config: PluginConfig,
  track: TrackInfo,
  progress: ImportProgress
): Promise<number | null> {
  const hasCustomSource = (config.customSources || []).some(s => s.value && s.value.length > 0 && s.enabled !== false) || (config.customSourceUrls || []).some(u => u.trim().length > 0);
  const hasExternalApi = config.luoxueApiUrl && !config.useBuiltinSource;

  let songId: number | null = null;

  // 尝试解析直接 URL（自定义音源脚本 → 外部 API）
  logInfo(`解析音源URL: ${track.title} - ${track.artist}`);
  const result = await resolveTrackUrl(config, track);
  if (result && result.url) {
    logInfo(`音源URL解析成功: ${track.title} → ${result.url.substring(0, 100)}... (source=${result.source})`);
    songId = await createRemoteSong(track, result.url);
  } else {
    logWarn(`音源URL解析失败: ${track.title}`);
  }

  // 直接 URL 解析失败
  if (!songId) {
    // 直接 URL 解析失败 → 回退到内置音源 sourceData，而不是因单个死后端丢弃整首
    logWarn(`音源解析失败，回退内置音源 sourceData: ${track.title}`);
    logInfo(`使用 sourceData: ${track.title}`);
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
    logInfo(`开始下载到本地: ${track.title} (songId=${songId})`);
    const downloadResult = await songloft.songs.download(songId);
    logInfo(`下载结果: ${track.title} - ${JSON.stringify(downloadResult)}`);
    if (downloadResult.status === 'ok' || downloadResult.status === 'done') {
      logInfo(`已下载: ${track.title} → ${downloadResult.path || '(路径未知)'}`);
      downloadSuccess = true;
    } else if (downloadResult.error) {
      logWarn(`下载未成功，已作为串流歌曲保留: ${track.title} - ${downloadResult.error}`);
    } else {
      logWarn(`下载状态未知: ${track.title} - ${JSON.stringify(downloadResult)}`);
    }
  } catch (e) {
    logWarn(`下载异常，已作为串流歌曲保留: ${track.title} - ${String(e)}`);
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
 * 执行歌单导入（两阶段并发优化）
 *
 * 阶段 1 — 预解析音源 URL（顺序执行，复用 jsenv 环境）
 *   逐首解析音源 URL，曲库已有的歌曲直接跳过。
 *   解析结果暂存，不创建歌曲也不下载。
 *
 * 阶段 2 — 并发创建歌曲并下载（并发数 = DOWNLOAD_CONCURRENCY）
 *   将阶段 1 的解析结果分批并发处理：创建远程歌曲 → 下载到本地 → 加入歌单。
 *   下载是网络 I/O，并发处理可大幅缩短总耗时。
 *
 * @param playlist 来源歌单信息
 * @param config 插件配置
 * @param progress 进度回调（会被直接修改）
 * @returns 导入的歌单 ID
 */

/** 并发下载数 */
const DOWNLOAD_CONCURRENCY = 3;

/** 预解析结果 */
interface ResolvedTrack {
  track: TrackInfo;
  url: string | null;
  sourceData: string | null;
}

export async function importPlaylist(
  playlist: PlaylistInfo,
  config: PluginConfig,
  progress: ImportProgress
): Promise<number | null> {
  progress.status = 'parsing';
  progress.phase = 'resolving';
  progress.total = playlist.tracks.length;
  progress.current = 0;
  progress.importedSongs = 0;
  progress.streamingSongs = 0;
  progress.downloadedSongs = 0;
  progress.errors = [];
  progress.resolveTotal = playlist.tracks.length;
  progress.resolveCurrent = 0;

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

  const collectedSongIds: number[] = [];

  // ==================== 阶段 1：预解析音源 URL（顺序） ====================
  logInfo(`阶段 1/2: 预解析音源 URL (${playlist.tracks.length} 首)`);
  const resolvedTracks: ResolvedTrack[] = [];

  const hasCustomSource = (config.customSources || []).some(s => s.value && s.value.length > 0 && s.enabled !== false) || (config.customSourceUrls || []).some(u => u.trim().length > 0);
  const hasExternalApi = config.luoxueApiUrl && !config.useBuiltinSource;
  const hasAnySource = hasCustomSource || hasExternalApi;

  for (let i = 0; i < playlist.tracks.length; i++) {
    const track = playlist.tracks[i];
    progress.resolveCurrent = i + 1;
    progress.current = i + 1;
    progress.currentTrack = `${track.title} - ${track.artist}`;
    progress.message = `[1/2] 解析音源 ${i + 1}/${playlist.tracks.length}: ${track.title}`;

    logInfo(`解析 ${i + 1}/${playlist.tracks.length}: ${track.title}`);

    try {
      // 先检查曲库中是否已有此歌曲
      const existingId = await findExistingSong(track);
      if (existingId) {
        logInfo(`曲库已有此歌曲: ${track.title} (id=${existingId})`);
        collectedSongIds.push(existingId);
        progress.importedSongs++;
        continue;
      }

      let url: string | null = null;
      let sourceData: string | null = null;

      if (hasAnySource) {
        // 有音源配置：解析 URL
        const result = await resolveTrackUrl(config, track);
        if (result && result.url) {
          url = result.url;
          logInfo(`URL 解析成功: ${track.title} → ${url.substring(0, 80)}...`);
        } else {
          // 音源（自定义脚本 / 外部 API）解析失败。
          // 典型根因：自定义音源后端服务不可用。
          //   例如用户常用的 huibq/latest.js 硬编码后端 https://lxmusicapi.onrender.com，
          //   该服务已被所有者停用（HTTP 503 Service Suspended），于是每首歌都取不到 URL。
          // 旧逻辑：直接 push「音源解析失败」并整首跳过 → 一个死后端导致整批歌曲全部报废（用户看到的“解析歌曲失败”）。
          // 新逻辑：回退到内置音源 sourceData，让 Songloft 继续尝试解析，至少保证歌单被导入而非全部失败。
          logWarn(`音源解析失败，回退到内置音源: ${track.title}`);
          progress.errors.push(`音源解析失败(已回退内置音源): ${track.title} - ${track.artist}`);
          sourceData = await generateSourceData(track, config);
        }
      } else {
        // 无音源配置：生成 sourceData
        sourceData = await generateSourceData(track, config);
        if (!sourceData) {
          progress.errors.push(`无法匹配曲目: ${track.title} - ${track.artist}`);
        }
      }

      resolvedTracks.push({ track, url, sourceData });
    } catch (e) {
      logError(`阶段1解析异常: ${track.title} - ${String(e)}`);
      progress.errors.push(`解析失败: ${track.title} - ${String(e)}`);
    }

    // 短延迟，避免请求过快
    if (i < playlist.tracks.length - 1) {
      await sleep(200);
    }
  }

  logInfo(`阶段 1 完成: ${collectedSongIds.length} 首已存在, ${resolvedTracks.length} 首待处理`);

  // ==================== 阶段 2：并发创建歌曲并下载 ====================
  logInfo(`阶段 2/2: 并发创建和下载 (并发数=${DOWNLOAD_CONCURRENCY})`);
  progress.phase = 'downloading';
  progress.status = config.importMode === 'download' ? 'downloading' : 'importing';
  progress.total = resolvedTracks.length;
  progress.current = 0;

  for (let i = 0; i < resolvedTracks.length; i += DOWNLOAD_CONCURRENCY) {
    const batch = resolvedTracks.slice(i, i + DOWNLOAD_CONCURRENCY);
    const batchStartIdx = i;

    // 并发处理这一批
    const promises = batch.map(async (item, batchIdx) => {
      const globalIdx = batchStartIdx + batchIdx;
      const { track, url, sourceData } = item;

      // ★ 进度显示修复：
      // 原实现立即在并发 promise 中写入 progress.current/track/message，
      // 三个 promise 同时执行，赋值顺序取决于 microtask 调度，前端会看到
      // 闪烁的"23/68 歌名A" / "24/68 歌名B" 反复横跳。
      // 修复：把进度写入推迟到「本任务真正的非异步操作之前」+ 「完成之后」，
      // 并在写之前检查是否已被同批前面的任务更新过，避免低编号被高编号覆盖。
      const reportProgress = (trackTitle: string) => {
        // 只有当进度计数器还指向更小的下标时，才推进到当前位置
        // 这样保证进度面板只会向前推进，不会回退
        if (progress.current <= globalIdx) {
          progress.current = globalIdx + 1;
          progress.currentTrack = `${trackTitle}`;
          progress.message = `[2/2] ${config.importMode === 'download' ? '下载' : '导入'} ${globalIdx + 1}/${resolvedTracks.length}: ${trackTitle}`;
        }
      };

      reportProgress(track.title);

      // 无 URL 且无 sourceData，跳过（解析阶段已记录错误）
      if (!url && !sourceData) {
        return null;
      }

      let songId: number | null = null;

      // 创建歌曲
      if (url) {
        songId = await createRemoteSong(track, url);
      } else if (sourceData) {
        songId = await createSongWithSourceData(track, sourceData);
      }

      if (!songId) {
        progress.errors.push(`无法创建歌曲: ${track.title}`);
        return null;
      }

      reportProgress(track.title);

      // 下载模式：尝试下载到本地
      if (config.importMode === 'download') {
        let downloadSuccess = false;
        try {
          logInfo(`开始下载: ${track.title} (songId=${songId})`);
          const downloadResult = await songloft.songs.download(songId);
          logInfo(`下载结果: ${track.title} - ${JSON.stringify(downloadResult)}`);
          if (downloadResult.status === 'ok' || downloadResult.status === 'done') {
            logInfo(`已下载: ${track.title} → ${downloadResult.path || '(路径未知)'}`);
            downloadSuccess = true;
          } else if (downloadResult.error) {
            logWarn(`下载未成功，已作为串流歌曲保留: ${track.title} - ${downloadResult.error}`);
          }
        } catch (e) {
          logWarn(`下载异常，已作为串流歌曲保留: ${track.title} - ${String(e)}`);
        }

        if (downloadSuccess) {
          // 累加计数器（仅在此分支内同步执行，避免 race condition）
          progress.downloadedSongs++;
        } else {
          progress.streamingSongs++;
        }
      } else {
        // 串流模式
        progress.streamingSongs++;
      }

      progress.importedSongs++;
      return songId;
    });

    const results = await Promise.all(promises);

    // 将成功的歌曲 ID 加入歌单
    const newIds = results.filter(id => id !== null) as number[];
    if (newIds.length > 0) {
      try {
        await addSongsToPlaylist(playlistId, newIds);
      } catch (e) {
        logWarn(`批次加入歌单失败: ${String(e)}`);
      }
    }

    // ★ 批次完成后，把进度推到本批最后一项（确保 UI 看到最新值）
    const lastIdxInBatch = Math.min(i + DOWNLOAD_CONCURRENCY, resolvedTracks.length);
    if (progress.current < lastIdxInBatch) {
      progress.current = lastIdxInBatch;
      const last = resolvedTracks[lastIdxInBatch - 1];
      if (last) {
        progress.currentTrack = `${last.track.title} - ${last.track.artist}`;
      }
      progress.message = `[2/2] ${config.importMode === 'download' ? '下载' : '导入'} ${lastIdxInBatch}/${resolvedTracks.length}`;
    }
  }

  // ==================== 完成 ====================
  progress.status = 'done';
  progress.phase = undefined;
  let msg = `导入完成：成功 ${progress.importedSongs}/${playlist.tracks.length} 首`;
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
