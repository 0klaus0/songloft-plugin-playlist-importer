/**
 * 歌单导入器插件 — 主入口
 *
 * 生命周期：onInit → onHTTPRequest (API 路由) → onDeinit
 *
 * API 路由：
 *   GET  /api/config      — 取得配置
 *   POST /api/config      — 保存配置
 *   GET  /api/platforms   — 取得支持平台列表
 *   POST /api/parse       — 解析分享链接
 *   POST /api/preview     — 解析 + 抓取歌单（预览曲目）
 *   POST /api/import      — 导入歌单到 Songloft
 *   GET  /api/status      — 取得导入进度
 *   POST /api/test-luoxue — 测试洛雪音源服务器连通性
 *   GET  /api/logs        — 取得日志
 *   POST /api/logs/clear  — 清空日志
 */
/// <reference types="@songloft/plugin-sdk" />
import { jsonResponse, createRouter } from '@songloft/plugin-sdk';
import { PluginConfig, ImportProgress, PlaylistInfo, CustomSource, LX_SOURCE_NAMES } from './types';
import { errorResponse, parseBody, bodyToString } from './utils';
import { loadConfig, saveConfig, validateConfig, saveUploadedSource, deleteUploadedSource, makeSourceFileId, SOURCE_FILE_KEY_PREFIX } from './config';
import { parseShareLink, getSupportedPlatforms } from './parsers';
import { fetchPlaylist } from './fetchers';
import { testLuoxueServer } from './luoxue';
import { importPlaylist } from './songloft-api';
import { getLogs, clearLogs, restoreLogs, logInfo, logWarn, logError } from './logger';
import { loadSourceContent, extractSourceMetadata } from './lx-source';

const router = createRouter();

/** 全局导入进度（用于轮询） */
let currentProgress: ImportProgress | null = null;

/** 缓存配置 */
let configCache: PluginConfig | null = null;

/**
 * 取得配置（带缓存）
 */
async function getConfig(): Promise<PluginConfig> {
  if (!configCache) {
    configCache = await loadConfig();
  }
  return configCache;
}

// ==================== API 路由 ====================

/** GET /api/config — 取得配置 */
router.get('/api/config', async () => {
  const config = await getConfig();
  // 不回传密码
  return jsonResponse({
    success: true,
    config: {
      ...config,
      luoxueApiPass: config.luoxueApiPass ? '******' : '',
    },
  });
});

/** POST /api/config — 保存配置 */
router.post('/api/config', async (req) => {
  const body = parseBody<Partial<PluginConfig>>(req.body);
  const currentConfig = await getConfig();

  // 合并配置（密码为 ****** 时保留原值）
  // 优先使用 customSources（新格式）；否则由旧字段 customSourceUrls 构建
  let customSources: CustomSource[];
  if (Array.isArray(body.customSources)) {
    customSources = body.customSources
      .filter((s) => s && (s.kind === 'url' || s.kind === 'file') && s.value)
      .map((s) => ({ kind: s.kind, value: String(s.value), name: s.name || String(s.value) }));
  } else if (Array.isArray(body.customSourceUrls)) {
    customSources = body.customSourceUrls
      .map((u) => String(u).trim())
      .filter((u) => u.length > 0)
      .map((u) => ({ kind: 'url' as const, value: u, name: u }));
  } else {
    customSources = currentConfig.customSources;
  }

  const newConfig: PluginConfig = {
    luoxueApiUrl: body.luoxueApiUrl ?? currentConfig.luoxueApiUrl,
    luoxueApiPass: body.luoxueApiPass === '******' ? currentConfig.luoxueApiPass : (body.luoxueApiPass ?? ''),
    defaultQuality: body.defaultQuality ?? currentConfig.defaultQuality,
    importMode: body.importMode ?? currentConfig.importMode,
    defaultSearchSource: body.defaultSearchSource ?? currentConfig.defaultSearchSource,
    useBuiltinSource: body.useBuiltinSource ?? currentConfig.useBuiltinSource,
    customSourceUrls: customSources.filter((s) => s.kind === 'url').map((s) => s.value),
    customSources,
  };

  // 验证
  const errors = validateConfig(newConfig);
  if (errors.length > 0) {
    return errorResponse(errors.join('; '));
  }

  await saveConfig(newConfig);
  configCache = newConfig;
  return jsonResponse({ success: true, message: '配置已保存' });
});

/** GET /api/platforms — 取得支持平台 */
router.get('/api/platforms', () => {
  return jsonResponse({
    success: true,
    platforms: getSupportedPlatforms(),
  });
});

/**
 * POST /api/upload-source — 上传洛雪音源脚本文件
 * 请求体为脚本原始字节（前端以 raw body 发送），文件名通过查询参数 ?name= 传递。
 * 脚本内容存于 songloft.storage（按内容哈希 id 索引，避免重复存储）。
 */
router.post('/api/upload-source', async (req) => {
  const raw = req.body;
  if (!raw || raw.length === 0) {
    return errorResponse('未收到文件内容');
  }
  // Uint8Array → UTF-8 字符串（兼容 QuickJS 运行时，不使用 TextDecoder）
  let content = bodyToString(raw).trim();

  if (content.length < 100) {
    return errorResponse('文件内容过短，可能不是有效的音源脚本');
  }
  // 轻量校验：排除 HTML 错误页，确认像洛雪音源脚本
  if (/^\s*<!doctype html|<html[\s>]/i.test(content) || !/(lx\.on|request|source)/i.test(content)) {
    return errorResponse('文件内容不像洛雪音源脚本（应包含 lx.on / source 等标识）');
  }

  // 文件名（来自查询参数，缺省用 id）
  let name = 'uploaded.js';
  try {
    const params = new URLSearchParams((req as { query?: string }).query || '');
    const n = params.get('name');
    if (n) name = n.trim() || 'uploaded.js';
  } catch { /* ignore */ }

  const id = makeSourceFileId(content);
  await saveUploadedSource(id, name, content);

  return jsonResponse({ success: true, id, name, size: content.length });
});

/**
 * POST /api/delete-source — 删除已上传的音源脚本文件
 * body: { id: string }
 */
router.post('/api/delete-source', async (req) => {
  const body = parseBody<{ id?: string }>(req.body);
  if (!body.id) {
    return errorResponse('缺少 id');
  }
  // 同时从配置中移除该文件引用
  const currentConfig = await getConfig();
  const before = currentConfig.customSources.length;
  currentConfig.customSources = currentConfig.customSources.filter(
    (s) => !(s.kind === 'file' && s.value === body.id)
  );
  if (currentConfig.customSources.length !== before) {
    await saveConfig(currentConfig);
    configCache = currentConfig;
  }
  await deleteUploadedSource(body.id);
  return jsonResponse({ success: true, message: '已删除' });
});

/**
 * 构建带元数据的音源列表（供前端"自定义源管理"界面展示）
 * 对每个源加载脚本内容并提取元数据（名称/作者/版本/描述/支持平台）。
 */
async function buildSourceList(config: PluginConfig): Promise<Array<Record<string, unknown>>> {
  const list: Array<Record<string, unknown>> = [];
  for (let i = 0; i < (config.customSources || []).length; i++) {
    const s = config.customSources[i];
    const item: Record<string, unknown> = {
      index: i,
      kind: s.kind,
      value: s.value,
      name: s.name || (s.kind === 'url' ? s.value : '上传脚本'),
      enabled: s.enabled !== false,
      author: s.author || '',
      version: s.version || '',
      description: s.description || '',
      platforms: s.platforms || [],
    };
    // 尝试加载脚本并补齐缺失的元数据
    try {
      const code = await loadSourceContent(s);
      if (code) {
        const meta = extractSourceMetadata(code);
        if (!item.author && meta.author) item.author = meta.author;
        if (!item.version && meta.version) item.version = meta.version;
        if (!item.description && meta.description) item.description = meta.description;
        if ((!item.platforms || item.platforms.length === 0) && meta.platforms) item.platforms = meta.platforms;
        if (!item.name || item.name === s.value || item.name === '上传脚本') {
          if (meta.name) item.name = meta.name;
        }
      }
    } catch { /* 忽略元数据提取失败 */ }
    list.push(item);
  }
  return list;
}

/** GET /api/sources — 获取音源列表（含元数据） */
router.get('/api/sources', async () => {
  const config = await getConfig();
  const sources = await buildSourceList(config);
  return jsonResponse({ success: true, sources });
});

/** POST /api/sources/add-url — 从 URL 添加音源（下载脚本并提取元数据） */
router.post('/api/sources/add-url', async (req) => {
  const body = parseBody<{ url?: string }>(req.body);
  const url = (body.url || '').trim();
  if (!url) return errorResponse('请输入音源 URL');
  if (!/^https?:\/\//i.test(url)) return errorResponse('URL 必须以 http:// 或 https:// 开头');

  const config = await getConfig();
  const existing = (config.customSources || []).find((s) => s.kind === 'url' && s.value === url);
  if (existing) return errorResponse('该音源已存在');

  // 下载脚本并提取元数据
  const code = await loadSourceContent({ kind: 'url', value: url, name: url });
  if (!code) return errorResponse('无法下载该音源脚本，请检查 URL 是否可访问');

  const meta = extractSourceMetadata(code);
  const source: CustomSource = {
    kind: 'url',
    value: url,
    name: meta.name || url,
    enabled: true,
    author: meta.author,
    version: meta.version,
    description: meta.description,
    platforms: meta.platforms as CustomSource['platforms'],
  };

  config.customSources = config.customSources || [];
  config.customSources.push(source);
  await saveConfig(config);
  configCache = config;

  logInfo(`已从 URL 添加音源: ${source.name} (${url})`);
  return jsonResponse({ success: true, source });
});

/** POST /api/sources/toggle — 启用/禁用音源 */
router.post('/api/sources/toggle', async (req) => {
  const body = parseBody<{ index?: number; enabled?: boolean }>(req.body);
  const idx = body.index;
  if (typeof idx !== 'number' || idx < 0) return errorResponse('缺少有效的音源索引');

  const config = await getConfig();
  const sources = config.customSources || [];
  if (idx >= sources.length) return errorResponse('音源索引越界');
  sources[idx].enabled = body.enabled !== false;
  await saveConfig(config);
  configCache = config;
  return jsonResponse({ success: true, message: sources[idx].enabled ? '已启用' : '已禁用' });
});

/** POST /api/sources/reorder — 调整音源顺序（body: { order: number[] }，新的索引顺序） */
router.post('/api/sources/reorder', async (req) => {
  const body = parseBody<{ order?: number[] }>(req.body);
  const order = body.order;
  if (!Array.isArray(order) || order.length === 0) return errorResponse('缺少排序信息');

  const config = await getConfig();
  const sources = config.customSources || [];
  if (order.length !== sources.length) return errorResponse('排序数据与音源数量不一致');

  const reordered: CustomSource[] = [];
  for (const idx of order) {
    if (typeof idx !== 'number' || idx < 0 || idx >= sources.length) {
      return errorResponse('排序数据包含无效索引');
    }
    reordered.push(sources[idx]);
  }
  config.customSources = reordered;
  await saveConfig(config);
  configCache = config;
  return jsonResponse({ success: true, message: '排序已保存' });
});

/** POST /api/sources/delete — 删除音源（body: { index: number }） */
router.post('/api/sources/delete', async (req) => {
  const body = parseBody<{ index?: number }>(req.body);
  const idx = body.index;
  if (typeof idx !== 'number' || idx < 0) return errorResponse('缺少有效的音源索引');

  const config = await getConfig();
  const sources = config.customSources || [];
  if (idx >= sources.length) return errorResponse('音源索引越界');

  const removed = sources[idx];
  // 若为上传文件，同时清理 storage 中的脚本文件
  if (removed.kind === 'file' && removed.value) {
    try { await deleteUploadedSource(removed.value); } catch { /* 忽略清理失败 */ }
  }
  sources.splice(idx, 1);
  await saveConfig(config);
  configCache = config;
  logInfo(`已删除音源: ${removed.name || removed.value}`);
  return jsonResponse({ success: true, message: '已删除' });
});

/** POST /api/parse — 解析分享链接 */
router.post('/api/parse', async (req) => {
  const body = parseBody<{ text: string }>(req.body);
  if (!body.text || body.text.trim() === '') {
    return errorResponse('请输入分享链接或文字');
  }

  const parsed = await parseShareLink(body.text);
  if (!parsed) {
    return errorResponse('无法识别此分享链接，请确认链接来自支持的平台');
  }

  return jsonResponse({ success: true, parsed });
});

/** POST /api/preview — 解析 + 抓取歌单（预览） */
router.post('/api/preview', async (req) => {
  const body = parseBody<{ text: string }>(req.body);
  if (!body.text || body.text.trim() === '') {
    return errorResponse('请输入分享链接或文字');
  }

  logInfo(`预览请求: ${body.text.substring(0, 100)}`);

  // 步骤 1：解析链接
  const parsed = await parseShareLink(body.text);
  if (!parsed) {
    logWarn('无法识别分享链接');
    return errorResponse('无法识别此分享链接');
  }

  logInfo(`解析成功: platform=${parsed.platform}, id=${parsed.playlistId}`);

  // 步骤 2：抓取歌单
  try {
    logInfo('开始抓取歌单...');
    const playlist = await fetchPlaylist(parsed.platform, parsed.playlistId);
    logInfo(`抓取完成: ${playlist.name}, ${playlist.tracks.length} 首`);
    // 回传歌单信息（不包含完整曲目列表，避免回应过大）
    const preview = {
      platform: playlist.platform,
      name: playlist.name,
      coverUrl: playlist.coverUrl,
      creator: playlist.creator,
      trackCount: playlist.tracks.length,
      // 只回传前 20 首作为预览
      previewTracks: playlist.tracks.slice(0, 20).map((t) => ({
        title: t.title,
        artist: t.artist,
        album: t.album,
        duration: t.duration,
      })),
    };
    return jsonResponse({ success: true, parsed, playlist: preview });
  } catch (e) {
    logError(`抓取歌单失败: ${String(e)}`);
    return errorResponse(`抓取歌单失败: ${String(e)}`);
  }
});

/** POST /api/import — 导入歌单 */
router.post('/api/import', async (req) => {
  const body = parseBody<{ text: string; mode?: string }>(req.body);
  if (!body.text || body.text.trim() === '') {
    return errorResponse('请输入分享链接或文字');
  }

  // 检查是否有正在进行的导入 — 返回成功响应并携带当前进度，让前端直接显示进度面板
  if (currentProgress && currentProgress.status !== 'done' && currentProgress.status !== 'error') {
    return jsonResponse({
      success: true,
      alreadyRunning: true,
      message: '已有导入任务正在进行',
      progress: currentProgress,
    });
  }

  const config = await getConfig();
  if (body.mode) {
    config.importMode = body.mode as 'download' | 'stream';
  }

  // 验证配置
  const errors = validateConfig(config);
  if (errors.length > 0) {
    return errorResponse(`配置不完整: ${errors.join('; ')}`);
  }

  // 先解析链接
  const parsed = await parseShareLink(body.text);
  if (!parsed) {
    return errorResponse('无法识别此分享链接');
  }

  // 初始化进度
  currentProgress = {
    total: 0,
    current: 0,
    status: 'parsing',
    message: `正在抓取歌单: ${parsed.platform} / ${parsed.playlistId}`,
    errors: [],
    importedSongs: 0,
    streamingSongs: 0,
    downloadedSongs: 0,
    phase: 'resolving',
    resolveTotal: 0,
    resolveCurrent: 0,
  };

  // 异步执行导入
  doImport(parsed.platform, parsed.playlistId, config).catch((e) => {
    if (currentProgress) {
      currentProgress.status = 'error';
      currentProgress.message = `导入失败: ${String(e)}`;
    }
    logError(`导入任务异常: ${String(e)}`);
  });

  return jsonResponse({
    success: true,
    message: '导入任务已启动',
    parsed,
  });
});

/** GET /api/status — 取得导入进度 */
router.get('/api/status', () => {
  if (!currentProgress) {
    return jsonResponse({ success: true, progress: null });
  }
  return jsonResponse({ success: true, progress: currentProgress });
});

/** POST /api/test-luoxue — 测试洛雪音源服务器（按平台返回状态） */
router.post('/api/test-luoxue', async () => {
  const config = await getConfig();
  const result = await testLuoxueServer(config);
  return jsonResponse({ success: true, ...result });
});

/** GET /api/logs — 取得日志 */
router.get('/api/logs', async (req) => {
  let limit = 0;
  try {
    const q = (req as { query?: string }).query;
    if (q) {
      const params = new URLSearchParams(q);
      const l = params.get('limit');
      if (l) limit = parseInt(l, 10) || 0;
    }
  } catch {
    // ignore
  }
  return jsonResponse({ success: true, logs: getLogs(limit) });
});

/** POST /api/logs/clear — 清空日志 */
router.post('/api/logs/clear', async () => {
  await clearLogs();
  return jsonResponse({ success: true, message: '日志已清空' });
});

// ==================== 异步导入 ====================

/**
 * 异步执行导入
 */
async function doImport(platform: string, playlistId: string, config: PluginConfig): Promise<void> {
  if (!currentProgress) return;

  try {
    // 步骤 1：抓取歌单
    currentProgress.status = 'fetching';
    currentProgress.message = '正在抓取歌单曲目...';
    const playlist: PlaylistInfo = await fetchPlaylist(platform as never, playlistId);

    // 步骤 2：导入
    await importPlaylist(playlist, config, currentProgress);
  } catch (e) {
    currentProgress.status = 'error';
    currentProgress.message = `导入失败: ${String(e)}`;
    logError(`导入失败: ${String(e)}`);
  }
}

// ==================== 生命周期 ====================

/**
 * 插件初始化
 */
async function onInit(): Promise<void> {
  // 恢复持久化日志
  await restoreLogs();
  logInfo('歌单导入器插件已加载');
  // 预加载配置
  getConfig().then((config) => {
    logInfo(`当前配置: 模式=${config.importMode}, 音质=${config.defaultQuality}, 来源=${config.defaultSearchSource}`);
    if (config.customSources && config.customSources.length > 0) {
      const urlN = config.customSources.filter((s) => s.kind === 'url').length;
      const fileN = config.customSources.filter((s) => s.kind === 'file').length;
      logInfo(`音源模式: ${config.customSources.length} 个自定义洛雪音源（URL ${urlN} / 上传 ${fileN}）`);
    } else if (config.useBuiltinSource) {
      logInfo('音源模式: Songloft 内置洛雪音源（无需外部 API）');
    } else if (config.luoxueApiUrl) {
      logInfo(`音源模式: 外部洛雪 API (${config.luoxueApiUrl})`);
    } else {
      logWarn('尚未配置音源，请在设置中填写自定义音源 URL、启用内置音源或填写外部 API 地址');
    }
  }).catch((e) => {
    logError('加载配置失败: ' + String(e));
  });
}

/**
 * 插件卸载
 */
function onDeinit(): void {
  logInfo('歌单导入器插件已卸载');
}

/**
 * HTTP 请求处理（插件对外服务入口）
 *
 * req.path 是相对于 entryPath 的路径，如 "/api/config"
 */
function onHTTPRequest(req: HTTPRequest): HTTPResponse | Promise<HTTPResponse> {
  return router.handle(req);
}

// ==================== 导出生命周期函数 ====================
// QuickJS 环境中，这些函数需要挂载到全局

// @ts-expect-error — QuickJS 全局注入
globalThis.onInit = onInit;
// @ts-expect-error — QuickJS 全局注入
globalThis.onDeinit = onDeinit;
// @ts-expect-error — QuickJS 全局注入
globalThis.onHTTPRequest = onHTTPRequest;
