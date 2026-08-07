/**
 * 歌单导入器插件 — 类型定义
 */
/// <reference types="@songloft/plugin-sdk" />

/** 支持的音乐平台 */
export type Platform = 'netease' | 'qqmusic' | 'kuwo' | 'kugou' | 'qishui';

/** 洛雪音源支持的来源 key */
export type LXSource = 'kw' | 'kg' | 'tx' | 'wy' | 'mg';

/** 音质选项 */
export type Quality = '128k' | '320k' | 'flac' | 'flac24bit';

/** 导入模式 */
export type ImportMode = 'download' | 'stream';

/** 平台到洛雪来源的映射（汽水音乐无直接对应，使用跨平台匹配） */
export const PLATFORM_TO_LX: Partial<Record<Platform, LXSource>> = {
  netease: 'wy',
  qqmusic: 'tx',
  kuwo: 'kw',
  kugou: 'kg',
  // qishui 无直接对应的洛雪来源，始终使用跨平台搜索匹配
};

/** 洛雪来源到中文名称的映射 */
export const LX_SOURCE_NAMES: Record<LXSource, string> = {
  kw: '酷我音乐',
  kg: '酷狗音乐',
  tx: 'QQ音乐',
  wy: '网易云音乐',
  mg: '咪咕音乐',
};

/** 平台中文名称 */
export const PLATFORM_NAMES: Record<Platform, string> = {
  netease: '网易云音乐',
  qqmusic: 'QQ音乐',
  kuwo: '酷我音乐',
  kugou: '酷狗音乐',
  qishui: '汽水音乐',
};

/** 解析后的分享链接 */
export interface ParsedShareLink {
  platform: Platform;
  playlistId: string;
  url: string;
  rawText?: string;
}

/** 单首曲目信息 */
export interface TrackInfo {
  title: string;
  artist: string;
  album?: string;
  duration?: number; // 秒
  platformSongId: string;
  platform: Platform;
}

/** 歌单信息 */
export interface PlaylistInfo {
  id: string;
  platform: Platform;
  name: string;
  coverUrl?: string;
  creator?: string;
  trackCount?: number;
  tracks: TrackInfo[];
}

/** 插件配置 */
export interface PluginConfig {
  /** 洛雪音源 API 服务器地址（如 http://192.168.1.100:8080） */
  luoxueApiUrl: string;
  /** 洛雪音源 API 密钥（可选） */
  luoxueApiPass: string;
  /** 默认音质 */
  defaultQuality: Quality;
  /** 导入模式：download=下载到本地, stream=串流导入 */
  importMode: ImportMode;
  /** 默认搜索来源（跨平台搜索时使用） */
  defaultSearchSource: LXSource;
}

/** 默认配置 */
export const DEFAULT_CONFIG: PluginConfig = {
  luoxueApiUrl: '',
  luoxueApiPass: '',
  defaultQuality: '320k',
  importMode: 'stream',
  defaultSearchSource: 'kw',
};

/** 导入进度回调 */
export interface ImportProgress {
  total: number;
  current: number;
  currentTrack?: string;
  status: 'parsing' | 'fetching' | 'downloading' | 'importing' | 'done' | 'error';
  message?: string;
  errors: string[];
  importedSongs: number;
}

/** 搜索结果 */
export interface SearchResult {
  songId: string;
  title: string;
  artist: string;
  album?: string;
  duration?: number;
  source: LXSource;
}
