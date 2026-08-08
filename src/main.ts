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
import { PluginConfig, ImportProgress, PlaylistInfo } from './types';
import { errorResponse, parseBody } from './utils';
import { loadConfig, saveConfig, validateConfig } from './config';
import { parseShareLink, getSupportedPlatforms } from './parsers';
import { fetchPlaylist } from './fetchers';
import { testLuoxueServer } from './luoxue';
import { importPlaylist } from './songloft-api';
import { getLogs, clearLogs, restoreLogs, logInfo, logWarn, logError } from './logger';

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
  const newConfig: PluginConfig = {
    luoxueApiUrl: body.luoxueApiUrl ?? currentConfig.luoxueApiUrl,
    luoxueApiPass: body.luoxueApiPass === '******' ? currentConfig.luoxueApiPass : (body.luoxueApiPass ?? ''),
    defaultQuality: body.defaultQuality ?? currentConfig.defaultQuality,
    importMode: body.importMode ?? currentConfig.importMode,
    defaultSearchSource: body.defaultSearchSource ?? currentConfig.defaultSearchSource,
    useBuiltinSource: body.useBuiltinSource ?? currentConfig.useBuiltinSource,
    customSourceUrls: Array.isArray(body.customSourceUrls) ? body.customSourceUrls : currentConfig.customSourceUrls,
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

  // 步骤 1：解析链接
  const parsed = await parseShareLink(body.text);
  if (!parsed) {
    return errorResponse('无法识别此分享链接');
  }

  // 步骤 2：抓取歌单
  try {
    const playlist = await fetchPlaylist(parsed.platform, parsed.playlistId);
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
    return errorResponse(`抓取歌单失败: ${String(e)}`);
  }
});

/** POST /api/import — 导入歌单 */
router.post('/api/import', async (req) => {
  const body = parseBody<{ text: string; mode?: string }>(req.body);
  if (!body.text || body.text.trim() === '') {
    return errorResponse('请输入分享链接或文字');
  }

  // 检查是否有正在进行的导入
  if (currentProgress && currentProgress.status !== 'done' && currentProgress.status !== 'error') {
    return errorResponse('已有导入任务正在进行，请等待完成', 409);
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

/** POST /api/test-luoxue — 测试洛雪音源服务器 */
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
    if (config.customSourceUrls && config.customSourceUrls.length > 0) {
      logInfo(`音源模式: ${config.customSourceUrls.length} 个自定义洛雪音源脚本`);
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
