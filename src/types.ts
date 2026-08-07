/**
 * 歌單匯入器插件 — 型別定義
 */

/** 支援的音樂平台 */
export type Platform = 'netease' | 'qqmusic' | 'kuwo' | 'kugou';

/** 洛雪音源支援的來源 key */
export type LXSource = 'kw' | 'kg' | 'tx' | 'wy' | 'mg';

/** 音質選項 */
export type Quality = '128k' | '320k' | 'flac' | 'flac24bit';

/** 匯入模式 */
export type ImportMode = 'download' | 'stream';

/** 平台到洛雪來源的映射 */
export const PLATFORM_TO_LX: Record<Platform, LXSource> = {
  netease: 'wy',
  qqmusic: 'tx',
  kuwo: 'kw',
  kugou: 'kg',
};

/** 洛雪來源到中文名稱的映射 */
export const LX_SOURCE_NAMES: Record<LXSource, string> = {
  kw: '酷我音樂',
  kg: '酷狗音樂',
  tx: 'QQ音樂',
  wy: '網易雲音樂',
  mg: '咪咕音樂',
};

/** 平台中文名稱 */
export const PLATFORM_NAMES: Record<Platform, string> = {
  netease: '網易雲音樂',
  qqmusic: 'QQ音樂',
  kuwo: '酷我音樂',
  kugou: '酷狗音樂',
};

/** 解析後的分享連結 */
export interface ParsedShareLink {
  platform: Platform;
  playlistId: string;
  url: string;
  rawText?: string;
}

/** 單首曲目資訊 */
export interface TrackInfo {
  title: string;
  artist: string;
  album?: string;
  duration?: number; // 秒
  platformSongId: string;
  platform: Platform;
}

/** 歌單資訊 */
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
  /** 洛雪音源 API 伺服器位址（如 http://192.168.1.100:8080） */
  luoxueApiUrl: string;
  /** 洛雪音源 API 密鑰（可選） */
  luoxueApiPass: string;
  /** 預設音質 */
  defaultQuality: Quality;
  /** 匯入模式：download=下載到本地, stream=串流匯入 */
  importMode: ImportMode;
  /** 預設搜尋來源（跨平台搜尋時使用） */
  defaultSearchSource: LXSource;
}

/** 預設配置 */
export const DEFAULT_CONFIG: PluginConfig = {
  luoxueApiUrl: '',
  luoxueApiPass: '',
  defaultQuality: '320k',
  importMode: 'download',
  defaultSearchSource: 'kw',
};

/** 匯入進度回呼 */
export interface ImportProgress {
  total: number;
  current: number;
  currentTrack?: string;
  status: 'parsing' | 'fetching' | 'downloading' | 'importing' | 'done' | 'error';
  message?: string;
  errors: string[];
  importedSongs: number;
}

/** HTTP 請求物件（Songloft 插件環境） */
export interface HttpRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
  query: Record<string, string>;
}

/** HTTP 回應物件 */
export interface HttpResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

/** 搜尋結果 */
export interface SearchResult {
  songId: string;
  title: string;
  artist: string;
  album?: string;
  duration?: number;
  source: LXSource;
}
