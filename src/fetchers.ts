/**
 * 歌單抓取器 — 從各平台 API 獲取歌單曲目列表
 *
 * 同時提供跨平台搜尋功能，用於歌單平台與洛雪音源平台不一致時的曲目匹配。
 */
import { PlaylistInfo, TrackInfo, Platform, LXSource, SearchResult } from './types';
import { fetchWithTimeout, decodeHtmlEntities } from './utils';

// ==================== 工具函數 ====================

/**
 * 從藝術家陣列中提取名稱字串
 */
function joinArtists(artists: { name?: string }[] | undefined): string {
  if (!artists || !Array.isArray(artists)) return '未知藝術家';
  return artists.map((a) => a.name || '').filter(Boolean).join('、') || '未知藝術家';
}

// ==================== 網易雲音樂 ====================

/**
 * 抓取網易雲音樂歌單
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
    throw new Error(`網易雲 API 回應狀態碼: ${resp.status}`);
  }

  const data = JSON.parse(resp.body);
  if (data.code !== 200 || !data.playlist) {
    throw new Error('網易雲歌單資料格式異常或歌單不存在');
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
    name: decodeHtmlEntities(playlist.name || '未知歌單'),
    coverUrl: playlist.coverImgUrl || playlist.picUrl || '',
    creator: (playlist.creator as Record<string, unknown>)?.nickname as string || '',
    trackCount: tracks.length,
    tracks,
  };
}

/**
 * 搜尋網易雲音樂
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

// ==================== QQ音樂 ====================

/**
 * 抓取QQ音樂歌單
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
    throw new Error(`QQ音樂 API 回應狀態碼: ${resp.status}`);
  }

  // QQ音樂可能返回 jsonp 格式，需要清理
  let body = resp.body.trim();
  if (body.startsWith('callback(')) {
    body = body.slice(9, -1);
  }
  if (body.startsWith('(')) {
    body = body.slice(1, -1);
  }

  const data = JSON.parse(body);
  if (!data.cdlist || !data.cdlist[0]) {
    throw new Error('QQ音樂歌單資料格式異常或歌單不存在');
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
    name: decodeHtmlEntities(cdlist.dissname || '未知歌單'),
    coverUrl: cdlist.logo || '',
    creator: cdlist.nickname || '',
    trackCount: tracks.length,
    tracks,
  };
}

/**
 * 搜尋QQ音樂
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

// ==================== 酷我音樂 ====================

/**
 * 抓取酷我音樂歌單
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
    throw new Error(`酷我 API 回應狀態碼: ${resp.status}`);
  }

  const data = JSON.parse(resp.body);
  if (!data.musiclist || data.musiclist.length === 0) {
    throw new Error('酷我歌單資料格式異常或歌單不存在');
  }

  const tracks: TrackInfo[] = (data.musiclist as Record<string, unknown>[]).map((m) => ({
    title: decodeHtmlEntities(m.name as string || ''),
    artist: decodeHtmlEntities(m.artist as string || '未知藝術家'),
    album: m.album as string || '',
    duration: Math.floor((m.duration as number || 0)),
    platformSongId: String(m.id),
    platform: 'kuwo' as Platform,
  })).filter((t: TrackInfo) => t.platformSongId);

  return {
    id: playlistId,
    platform: 'kuwo',
    name: decodeHtmlEntities(data.title || '未知歌單'),
    coverUrl: data.pic || data.pic300 || '',
    creator: data.uname || '',
    trackCount: tracks.length,
    tracks,
  };
}

/**
 * 搜尋酷我音樂
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
    artist: decodeHtmlEntities(s.ARTIST as string || '未知藝術家'),
    album: s.ALBUM as string || '',
    duration: Math.floor((s.DURATION as number || 0)),
    source: 'kw' as LXSource,
  })).filter((r) => r.songId);
}

// ==================== 酷狗音樂 ====================

/**
 * 抓取酷狗音樂歌單
 */
export async function fetchKugouPlaylist(playlistId: string): Promise<PlaylistInfo> {
  // 先取得歌單資訊
  const infoUrl = `http://mobilecdn.kugou.com/api/v3/special/info?specialid=${playlistId}`;
  const infoResp = await fetchWithTimeout(infoUrl, {
    method: 'GET',
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  }, 10000);

  let playlistName = '未知歌單';
  let coverUrl = '';
  let creator = '';

  try {
    const infoData = JSON.parse(infoResp.body);
    if (infoData.status === 1 && infoData.data) {
      playlistName = decodeHtmlEntities(infoData.data.specialname || '未知歌單');
      coverUrl = infoData.data.imgurl || '';
      creator = infoData.data.nickname || '';
    }
  } catch { /* 忽略 */ }

  // 取得歌單歌曲列表
  const songsUrl = `http://mobilecdn.kugou.com/api/v3/special/song?specialid=${playlistId}&page=1&pagesize=200&version=9108`;
  const songsResp = await fetchWithTimeout(songsUrl, {
    method: 'GET',
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  }, 15000);

  if (songsResp.status !== 200) {
    throw new Error(`酷狗 API 回應狀態碼: ${songsResp.status}`);
  }

  const songsData = JSON.parse(songsResp.body);
  if (!songsData.data || !songsData.data.info) {
    throw new Error('酷狗歌單資料格式異常或歌單不存在');
  }

  const tracks: TrackInfo[] = (songsData.data.info as Record<string, unknown>[]).map((s) => ({
    title: decodeHtmlEntities(s.filename as string || s.name as string || ''),
    artist: decodeHtmlEntities(s.singername as string || '未知藝術家'),
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
 * 搜尋酷狗音樂
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
    artist: decodeHtmlEntities(s.singername as string || '未知藝術家'),
    album: s.album_name as string || '',
    duration: Math.floor((s.duration as number || 0)),
    source: 'kg' as LXSource,
  })).filter((r) => r.songId && r.songId !== '0');
}

// ==================== 統一介面 ====================

/** 各平台歌單抓取函數映射 */
const PLAYLIST_FETCHERS: Record<Platform, (id: string) => Promise<PlaylistInfo>> = {
  netease: fetchNeteasePlaylist,
  qqmusic: fetchQQMusicPlaylist,
  kuwo: fetchKuwoPlaylist,
  kugou: fetchKugouPlaylist,
};

/** 各平台搜尋函數映射 */
const SEARCH_FUNCTIONS: Record<LXSource, (keyword: string, limit?: number) => Promise<SearchResult[]>> = {
  wy: searchNetease,
  tx: searchQQMusic,
  kw: searchKuwo,
  kg: searchKugou,
  mg: async (_kw: string) => [], // 咪咕暫不支援搜尋
};

/**
 * 抓取歌單（統一入口）
 */
export async function fetchPlaylist(platform: Platform, playlistId: string): Promise<PlaylistInfo> {
  const fetcher = PLAYLIST_FETCHERS[platform];
  if (!fetcher) {
    throw new Error(`不支援的平台: ${platform}`);
  }
  songloft.log.info(`開始抓取歌單: platform=${platform}, id=${playlistId}`);
  const playlist = await fetcher(playlistId);
  songloft.log.info(`歌單抓取完成: ${playlist.name}, 共 ${playlist.tracks.length} 首`);
  return playlist;
}

/**
 * 搜尋歌曲（統一入口）
 */
export async function searchMusic(
  keyword: string,
  source: LXSource,
  limit = 10
): Promise<SearchResult[]> {
  const searcher = SEARCH_FUNCTIONS[source];
  if (!searcher) {
    throw new Error(`不支援的搜尋來源: ${source}`);
  }
  return searcher(keyword, limit);
}
