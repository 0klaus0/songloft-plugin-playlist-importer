/**
 * 歌单抓取器 — 从各平台 API 获取歌单曲目列表
 *
 * 同时提供跨平台搜索功能，用于歌单平台与洛雪音源平台不一致时的曲目匹配。
 */
/// <reference types="@songloft/plugin-sdk" />
import { PlaylistInfo, TrackInfo, Platform, LXSource, SearchResult } from './types';
import { fetchWithTimeout, decodeHtmlEntities } from './utils';

// ==================== 工具函数 ====================

/**
 * 从艺术家数组中提取名称字符串
 */
function joinArtists(artists: { name?: string }[] | undefined): string {
  if (!artists || !Array.isArray(artists)) return '未知艺术家';
  return artists.map((a) => a.name || '').filter(Boolean).join('、') || '未知艺术家';
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

  const data = JSON.parse(resp.body);
  if (data.code !== 200 || !data.playlist) {
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

  const data = JSON.parse(resp.body);
  if (!data.result || !data.result.songs) return [];

  return (data.result.songs as Record<string, unknown>[]).map((s) => ({
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

  const data = JSON.parse(body);
  if (!data.cdlist || !data.cdlist[0]) {
    throw new Error('QQ音乐歌单数据格式异常或歌单不存在');
  }

  const cdlist = data.cdlist[0];
  const tracks: TrackInfo[] = (cdlist.songlist || []).map((s: Record<string, unknown>) => ({
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

  const data = JSON.parse(body);
  if (!data.data || !data.data.song || !data.data.song.list) return [];

  return (data.data.song.list as Record<string, unknown>[]).map((s) => ({
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

  const data = JSON.parse(resp.body);
  if (!data.musiclist || data.musiclist.length === 0) {
    throw new Error('酷我歌单数据格式异常或歌单不存在');
  }

  const tracks: TrackInfo[] = (data.musiclist as Record<string, unknown>[]).map((m) => ({
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

  const data = JSON.parse(resp.body);
  if (!data.abslist || data.abslist.length === 0) return [];

  return (data.abslist as Record<string, unknown>[]).map((s) => ({
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
    const infoData = JSON.parse(infoResp.body);
    if (infoData.status === 1 && infoData.data) {
      playlistName = decodeHtmlEntities(infoData.data.specialname || '未知歌单');
      coverUrl = infoData.data.imgurl || '';
      creator = infoData.data.nickname || '';
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

  const songsData = JSON.parse(songsResp.body);
  if (!songsData.data || !songsData.data.info) {
    throw new Error('酷狗歌单数据格式异常或歌单不存在');
  }

  const tracks: TrackInfo[] = (songsData.data.info as Record<string, unknown>[]).map((s) => ({
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
 */
export async function searchKugou(keyword: string, limit = 10): Promise<SearchResult[]> {
  const url = `http://mobilecdn.kugou.com/api/v3/search/song?keyword=${encodeURIComponent(keyword)}&pagesize=${limit}&page=1&version=9108`;
  const resp = await fetchWithTimeout(url, {
    method: 'GET',
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  }, 10000);

  const data = JSON.parse(resp.body);
  if (!data.data || !data.data.info) return [];

  return (data.data.info as Record<string, unknown>[]).map((s) => ({
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
 * 从汽水音乐分享页面提取 _ROUTER_DATA JSON
 */
function extractRouterData(html: string): Record<string, unknown> | null {
  // 匹配 _ROUTER_DATA = {...};
  const patterns = [
    /_ROUTER_DATA\s*=\s*(\{[\s\S]*?\});\s*<\/script>/,
    /_ROUTER_DATA\s*=\s*(\{[\s\S]*?\})\s*<\/script>/,
    /_ROUTER_DATA\s*=\s*(\{[\s\S]*?\});/,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) {
      try {
        return JSON.parse(match[1]);
      } catch {
        // 尝试修复 JSON 末尾多余逗号
        try {
          const fixed = match[1].replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
          return JSON.parse(fixed);
        } catch {
          continue;
        }
      }
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
 */
function findAllAudioData(obj: unknown, results: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (!obj || typeof obj !== 'object') return results;
  const record = obj as Record<string, unknown>;

  // 检查是否是包含 trackName 的音频数据
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

  songloft.log.info(`抓取汽水音乐分享: ${shareUrl}`);

  const resp = await fetchWithTimeout(shareUrl, {
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    },
  }, 15000);

  if (resp.status !== 200) {
    throw new Error(`汽水音乐页面请求失败: HTTP ${resp.status}`);
  }

  const html = resp.body;

  // 提取 _ROUTER_DATA
  const routerData = extractRouterData(html);
  if (!routerData) {
    throw new Error('无法从汽水音乐页面提取数据，可能是链接已失效或页面结构已变更');
  }

  // 查找所有音频数据
  const audioDataList = findAllAudioData(routerData);

  if (audioDataList.length === 0) {
    throw new Error('汽水音乐分享中未找到曲目信息');
  }

  // 解析曲目列表
  const tracks: TrackInfo[] = audioDataList.map((audio) => {
    const trackName = decodeHtmlEntities(String(audio.trackName || '未知歌曲'));
    const artistName = decodeHtmlEntities(String(audio.artistName || '未知艺术家'));
    const duration = Math.floor(Number(audio.duration || 0));
    const coverURL = String(audio.coverURL || '');
    const trackInfo = audio.trackInfo as Record<string, unknown> | undefined;
    const album = trackInfo?.album as Record<string, unknown> | undefined;
    const albumName = album?.name ? String(album.name) : '';

    return {
      title: trackName,
      artist: artistName,
      album: albumName,
      duration,
      platformSongId: String(trackInfo?.album?.id || audio.trackName || ''),
      platform: 'qishui' as Platform,
    };
  });

  // 从第一首获取封面和歌单信息
  const firstAudio = audioDataList[0];
  const coverUrl = String(firstAudio.coverURL || '');
  const playlistName = tracks.length > 1
    ? `汽水音乐分享 (${tracks.length}首)`
    : String(firstAudio.trackName || '汽水音乐分享');

  return {
    id: shareId,
    platform: 'qishui',
    name: playlistName,
    coverUrl,
    creator: '汽水音乐',
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
  songloft.log.info(`开始抓取歌单: platform=${platform}, id=${playlistId}`);
  const playlist = await fetcher(playlistId);
  songloft.log.info(`歌单抓取完成: ${playlist.name}, 共 ${playlist.tracks.length} 首`);
  return playlist;
}

/**
 * 搜索歌曲（统一入口）
 */
export async function searchMusic(
  keyword: string,
  source: LXSource,
  limit = 10
): Promise<SearchResult[]> {
  const searcher = SEARCH_FUNCTIONS[source];
  if (!searcher) {
    throw new Error(`不支持的搜索来源: ${source}`);
  }
  return searcher(keyword, limit);
}
