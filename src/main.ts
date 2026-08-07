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
 */
import { HttpRequest, HttpResponse, PluginConfig, ImportProgress, PlaylistInfo } from './types';
import { jsonResponse, errorResponse, parseBody } from './utils';
import { loadConfig, saveConfig, validateConfig } from './config';
import { parseShareLink, getSupportedPlatforms } from './parsers';
import { fetchPlaylist } from './fetchers';
import { testLuoxueServer } from './luoxue';
import { importPlaylist } from './songloft-api';

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

// ==================== API 处理函数 ====================

/**
 * GET /api/config — 取得配置
 */
async function handleGetConfig(): Promise<HttpResponse> {
  const config = await getConfig();
  // 不回传密码
  return jsonResponse({
    success: true,
    config: {
      ...config,
      luoxueApiPass: config.luoxueApiPass ? '******' : '',
    },
  });
}

/**
 * POST /api/config — 保存配置
 */
async function handleSaveConfig(req: HttpRequest): Promise<HttpResponse> {
  const body = parseBody<Partial<PluginConfig>>(req.body);
  const currentConfig = await getConfig();

  // 合并配置（密码为 ****** 时保留原值）
  const newConfig: PluginConfig = {
    luoxueApiUrl: body.luoxueApiUrl ?? currentConfig.luoxueApiUrl,
    luoxueApiPass: body.luoxueApiPass === '******' ? currentConfig.luoxueApiPass : (body.luoxueApiPass ?? ''),
    defaultQuality: body.defaultQuality ?? currentConfig.defaultQuality,
    importMode: body.importMode ?? currentConfig.importMode,
    defaultSearchSource: body.defaultSearchSource ?? currentConfig.defaultSearchSource,
  };

  // 验证
  const errors = validateConfig(newConfig);
  if (errors.length > 0) {
    return errorResponse(errors.join('; '));
  }

  await saveConfig(newConfig);
  configCache = newConfig;
  return jsonResponse({ success: true, message: '配置已保存' });
}

/**
 * GET /api/platforms — 取得支持平台
 */
function handleGetPlatforms(): HttpResponse {
  return jsonResponse({
    success: true,
    platforms: getSupportedPlatforms(),
  });
}

/**
 * POST /api/parse — 解析分享链接
 */
async function handleParse(req: HttpRequest): Promise<HttpResponse> {
  const body = parseBody<{ text: string }>(req.body);
  if (!body.text || body.text.trim() === '') {
    return errorResponse('请输入分享链接或文字');
  }

  const parsed = await parseShareLink(body.text);
  if (!parsed) {
    return errorResponse('无法识别此分享链接，请确认链接来自支持的平台');
  }

  return jsonResponse({ success: true, parsed });
}

/**
 * POST /api/preview — 解析 + 抓取歌单（预览）
 */
async function handlePreview(req: HttpRequest): Promise<HttpResponse> {
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
}

/**
 * POST /api/import — 导入歌单
 */
async function handleImport(req: HttpRequest): Promise<HttpResponse> {
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

  // 立即回应，异步执行导入
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
  };

  // 异步执行导入
  doImport(parsed.platform, parsed.playlistId, config).catch((e) => {
    if (currentProgress) {
      currentProgress.status = 'error';
      currentProgress.message = `导入失败: ${String(e)}`;
    }
    songloft.log.error(`导入任务异常: ${String(e)}`);
  });

  return jsonResponse({
    success: true,
    message: '导入任务已启动',
    parsed,
  });
}

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
    songloft.log.error(`导入失败: ${String(e)}`);
  }
}

/**
 * GET /api/status — 取得导入进度
 */
function handleStatus(): HttpResponse {
  if (!currentProgress) {
    return jsonResponse({ success: true, progress: null });
  }
  return jsonResponse({ success: true, progress: currentProgress });
}

/**
 * POST /api/test-luoxue — 测试洛雪音源服务器
 */
async function handleTestLuoxue(): Promise<HttpResponse> {
  const config = await getConfig();
  const result = await testLuoxueServer(config);
  return jsonResponse({ success: true, ...result });
}

// ==================== HTTP 路由 ====================

/**
 * 处理 HTTP 请求
 */
async function handleApiRequest(req: HttpRequest): Promise<HttpResponse> {
  const path = req.path;
  const method = req.method.toUpperCase();

  try {
    // 路由匹配
    if (path.endsWith('/api/config') && method === 'GET') {
      return await handleGetConfig();
    }
    if (path.endsWith('/api/config') && method === 'POST') {
      return await handleSaveConfig(req);
    }
    if (path.endsWith('/api/platforms') && method === 'GET') {
      return handleGetPlatforms();
    }
    if (path.endsWith('/api/parse') && method === 'POST') {
      return await handleParse(req);
    }
    if (path.endsWith('/api/preview') && method === 'POST') {
      return await handlePreview(req);
    }
    if (path.endsWith('/api/import') && method === 'POST') {
      return await handleImport(req);
    }
    if (path.endsWith('/api/status') && method === 'GET') {
      return handleStatus();
    }
    if (path.endsWith('/api/test-luoxue') && method === 'POST') {
      return await handleTestLuoxue();
    }

    return errorResponse(`未知路由: ${method} ${path}`, 404);
  } catch (e) {
    songloft.log.error(`API 处理异常: ${String(e)}`);
    return errorResponse(`服务器内部错误: ${String(e)}`, 500);
  }
}

// ==================== 生命周期 ====================

/**
 * 插件初始化
 */
function onInit(): void {
  songloft.log.info('歌单导入器插件已加载');
  // 预加载配置
  getConfig().then((config) => {
    songloft.log.info(`当前配置: 模式=${config.importMode}, 音质=${config.defaultQuality}`);
    if (config.luoxueApiUrl) {
      songloft.log.info(`洛雪音源: ${config.luoxueApiUrl}`);
    } else {
      songloft.log.warn('尚未配置洛雪音源 API 地址');
    }
  }).catch((e) => {
    songloft.log.error('加载配置失败: ' + String(e));
  });
}

/**
 * 插件卸载
 */
function onDeinit(): void {
  songloft.log.info('歌单导入器插件已卸载');
}

/**
 * HTTP 请求处理（插件对外服务入口）
 */
function onHTTPRequest(req: HttpRequest): HttpResponse | Promise<HttpResponse> {
  // 所有 /api/ 路径走 API 处理
  if (req.path.includes('/api/')) {
    return handleApiRequest(req);
  }
  // 其他路径返回 404（静态资源由 Songloft 自动托管）
  return {
    statusCode: 404,
    headers: { 'Content-Type': 'text/plain' },
    body: 'Not Found',
  };
}

// ==================== 导出生命周期函数 ====================
// QuickJS 环境中，这些函数需要挂载到全局

const globalObj = globalThis as unknown as Record<string, unknown>;
globalObj.onInit = onInit;
globalObj.onDeinit = onDeinit;
globalObj.onHTTPRequest = onHTTPRequest;
