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

/** 全部洛雪来源（按常用优先级排序，用于多渠道回退与平台探测） */
export const ALL_LX_SOURCES: LXSource[] = ['kw', 'kg', 'tx', 'wy', 'mg'];

/**
 * 自定义音源（统一描述：既支持 URL，也支持本地上传的脚本文件）
 * - kind='url'：value 为脚本地址（http/https）
 * - kind='file'：value 为插件 storage 中的文件 id（脚本内容存于 storage）
 */
export interface CustomSource {
  kind: 'url' | 'file';
  value: string;
  name: string;
  /** 是否启用（false 时跳过该源，默认 true） */
  enabled?: boolean;
  /** 脚本作者（从脚本头部注释解析） */
  author?: string;
  /** 脚本版本（从脚本头部注释解析） */
  version?: string;
  /** 脚本描述（从脚本头部注释解析） */
  description?: string;
  /** 脚本声明支持的来源（kw/kg/tx/wy/mg），由初始化时探测得到 */
  platforms?: LXSource[];
}

/** 单个平台的检测结果（用于前端像洛雪一样按平台展示可用性） */
export interface PlatformStatus {
  source: LXSource;
  name: string;
  status: 'ok' | 'fail' | 'unsupported' | 'unreachable';
  reason?: string;
  /** 取 URL 耗时（毫秒），探测期间为真实请求延迟 */
  latencyMs?: number;
}

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
  /** 洛雪音源 API 服务器地址（如 http://192.168.1.100:8080），留空则使用 Songloft 内置音源 */
  luoxueApiUrl: string;
  /** 洛雪音源 API 密钥（可选） */
  luoxueApiPass: string;
  /** 默认音质 */
  defaultQuality: Quality;
  /** 导入模式：download=下载到本地, stream=串流导入 */
  importMode: ImportMode;
  /** 默认搜索来源（跨平台搜索时使用） */
  defaultSearchSource: LXSource;
  /** 是否使用 Songloft 内置音源（true 时不需要外部洛雪 API） */
  useBuiltinSource: boolean;
  /** 自定义洛雪音源脚本 URL 列表（支持多个，按顺序尝试）—— 向后兼容，新版本使用 customSources */
  customSourceUrls: string[];
  /** 自定义洛雪音源（统一描述：URL 或本地上传的脚本文件） */
  customSources: CustomSource[];
}

/** 默认配置 */
export const DEFAULT_CONFIG: PluginConfig = {
  luoxueApiUrl: '',
  luoxueApiPass: '',
  defaultQuality: '320k',
  importMode: 'stream',
  defaultSearchSource: 'kw',
  useBuiltinSource: true,
  customSourceUrls: [],
  customSources: [],
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
  /** 串流歌曲数（创建成功但未下载到本地） */
  streamingSongs: number;
  /** 已下载到本地的歌曲数 */
  downloadedSongs: number;
  /** 当前阶段：resolving=解析音源URL, downloading=下载歌曲 */
  phase?: 'resolving' | 'downloading';
  /** 解析阶段总数 */
  resolveTotal?: number;
  /** 解析阶段当前数 */
  resolveCurrent?: number;
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
