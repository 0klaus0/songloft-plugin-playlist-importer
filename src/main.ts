/**
 * 歌單匯入器插件 — 主入口
 *
 * 生命週期：onInit → onHTTPRequest (API 路由) → onDeinit
 *
 * API 路由：
 *   GET  /api/config      — 取得配置
 *   POST /api/config      — 儲存配置
 *   GET  /api/platforms   — 取得支援平台列表
 *   POST /api/parse       — 解析分享連結
 *   POST /api/preview     — 解析 + 抓取歌單（預覽曲目）
 *   POST /api/import      — 匯入歌單到 Songloft
 *   GET  /api/status      — 取得匯入進度
 *   POST /api/test-luoxue — 測試洛雪音源伺服器連通性
 */
import { HttpRequest, HttpResponse, PluginConfig, ImportProgress, PlaylistInfo } from './types';
import { jsonResponse, errorResponse, parseBody } from './utils';
import { loadConfig, saveConfig, validateConfig } from './config';
import { parseShareLink, getSupportedPlatforms } from './parsers';
import { fetchPlaylist } from './fetchers';
import { testLuoxueServer } from './luoxue';
import { importPlaylist } from './songloft-api';

/** 全域匯入進度（用於輪詢） */
let currentProgress: ImportProgress | null = null;

/** 快取配置 */
let configCache: PluginConfig | null = null;

/**
 * 取得配置（帶快取）
 */
async function getConfig(): Promise<PluginConfig> {
  if (!configCache) {
    configCache = await loadConfig();
  }
  return configCache;
}

// ==================== API 處理函數 ====================

/**
 * GET /api/config — 取得配置
 */
async function handleGetConfig(): Promise<HttpResponse> {
  const config = await getConfig();
  // 不回傳密碼
  return jsonResponse({
    success: true,
    config: {
      ...config,
      luoxueApiPass: config.luoxueApiPass ? '******' : '',
    },
  });
}

/**
 * POST /api/config — 儲存配置
 */
async function handleSaveConfig(req: HttpRequest): Promise<HttpResponse> {
  const body = parseBody<Partial<PluginConfig>>(req.body);
  const currentConfig = await getConfig();

  // 合併配置（密碼為 ****** 時保留原值）
  const newConfig: PluginConfig = {
    luoxueApiUrl: body.luoxueApiUrl ?? currentConfig.luoxueApiUrl,
    luoxueApiPass: body.luoxueApiPass === '******' ? currentConfig.luoxueApiPass : (body.luoxueApiPass ?? ''),
    defaultQuality: body.defaultQuality ?? currentConfig.defaultQuality,
    importMode: body.importMode ?? currentConfig.importMode,
    defaultSearchSource: body.defaultSearchSource ?? currentConfig.defaultSearchSource,
  };

  // 驗證
  const errors = validateConfig(newConfig);
  if (errors.length > 0) {
    return errorResponse(errors.join('; '));
  }

  await saveConfig(newConfig);
  configCache = newConfig;
  return jsonResponse({ success: true, message: '配置已儲存' });
}

/**
 * GET /api/platforms — 取得支援平台
 */
function handleGetPlatforms(): HttpResponse {
  return jsonResponse({
    success: true,
    platforms: getSupportedPlatforms(),
  });
}

/**
 * POST /api/parse — 解析分享連結
 */
async function handleParse(req: HttpRequest): Promise<HttpResponse> {
  const body = parseBody<{ text: string }>(req.body);
  if (!body.text || body.text.trim() === '') {
    return errorResponse('請輸入分享連結或文字');
  }

  const parsed = await parseShareLink(body.text);
  if (!parsed) {
    return errorResponse('無法識別此分享連結，請確認連結來自支援的平台');
  }

  return jsonResponse({ success: true, parsed });
}

/**
 * POST /api/preview — 解析 + 抓取歌單（預覽）
 */
async function handlePreview(req: HttpRequest): Promise<HttpResponse> {
  const body = parseBody<{ text: string }>(req.body);
  if (!body.text || body.text.trim() === '') {
    return errorResponse('請輸入分享連結或文字');
  }

  // 步驟 1：解析連結
  const parsed = await parseShareLink(body.text);
  if (!parsed) {
    return errorResponse('無法識別此分享連結');
  }

  // 步驟 2：抓取歌單
  try {
    const playlist = await fetchPlaylist(parsed.platform, parsed.playlistId);
    // 回傳歌單資訊（不包含完整曲目列表，避免回應過大）
    const preview = {
      platform: playlist.platform,
      name: playlist.name,
      coverUrl: playlist.coverUrl,
      creator: playlist.creator,
      trackCount: playlist.tracks.length,
      // 只回傳前 20 首作為預覽
      previewTracks: playlist.tracks.slice(0, 20).map((t) => ({
        title: t.title,
        artist: t.artist,
        album: t.album,
        duration: t.duration,
      })),
    };
    return jsonResponse({ success: true, parsed, playlist: preview });
  } catch (e) {
    return errorResponse(`抓取歌單失敗: ${String(e)}`);
  }
}

/**
 * POST /api/import — 匯入歌單
 */
async function handleImport(req: HttpRequest): Promise<HttpResponse> {
  const body = parseBody<{ text: string; mode?: string }>(req.body);
  if (!body.text || body.text.trim() === '') {
    return errorResponse('請輸入分享連結或文字');
  }

  // 檢查是否有正在進行的匯入
  if (currentProgress && currentProgress.status !== 'done' && currentProgress.status !== 'error') {
    return errorResponse('已有匯入任務正在進行，請等待完成', 409);
  }

  const config = await getConfig();
  if (body.mode) {
    config.importMode = body.mode as 'download' | 'stream';
  }

  // 驗證配置
  const errors = validateConfig(config);
  if (errors.length > 0) {
    return errorResponse(`配置不完整: ${errors.join('; ')}`);
  }

  // 立即回應，非同步執行匯入
  // 先解析連結
  const parsed = await parseShareLink(body.text);
  if (!parsed) {
    return errorResponse('無法識別此分享連結');
  }

  // 初始化進度
  currentProgress = {
    total: 0,
    current: 0,
    status: 'parsing',
    message: `正在抓取歌單: ${parsed.platform} / ${parsed.playlistId}`,
    errors: [],
    importedSongs: 0,
  };

  // 非同步執行匯入
  doImport(parsed.platform, parsed.playlistId, config).catch((e) => {
    if (currentProgress) {
      currentProgress.status = 'error';
      currentProgress.message = `匯入失敗: ${String(e)}`;
    }
    songloft.log.error(`匯入任務異常: ${String(e)}`);
  });

  return jsonResponse({
    success: true,
    message: '匯入任務已啟動',
    parsed,
  });
}

/**
 * 非同步執行匯入
 */
async function doImport(platform: string, playlistId: string, config: PluginConfig): Promise<void> {
  if (!currentProgress) return;

  try {
    // 步驟 1：抓取歌單
    currentProgress.status = 'fetching';
    currentProgress.message = '正在抓取歌單曲目...';
    const playlist: PlaylistInfo = await fetchPlaylist(platform as never, playlistId);

    // 步驟 2：匯入
    await importPlaylist(playlist, config, currentProgress);
  } catch (e) {
    currentProgress.status = 'error';
    currentProgress.message = `匯入失敗: ${String(e)}`;
    songloft.log.error(`匯入失敗: ${String(e)}`);
  }
}

/**
 * GET /api/status — 取得匯入進度
 */
function handleStatus(): HttpResponse {
  if (!currentProgress) {
    return jsonResponse({ success: true, progress: null });
  }
  return jsonResponse({ success: true, progress: currentProgress });
}

/**
 * POST /api/test-luoxue — 測試洛雪音源伺服器
 */
async function handleTestLuoxue(): Promise<HttpResponse> {
  const config = await getConfig();
  const result = await testLuoxueServer(config);
  return jsonResponse({ success: true, ...result });
}

// ==================== HTTP 路由 ====================

/**
 * 處理 HTTP 請求
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
    songloft.log.error(`API 處理異常: ${String(e)}`);
    return errorResponse(`伺服器內部錯誤: ${String(e)}`, 500);
  }
}

// ==================== 生命週期 ====================

/**
 * 插件初始化
 */
function onInit(): void {
  songloft.log.info('歌單匯入器插件已載入');
  // 預載入配置
  getConfig().then((config) => {
    songloft.log.info(`當前配置: 模式=${config.importMode}, 音質=${config.defaultQuality}`);
    if (config.luoxueApiUrl) {
      songloft.log.info(`洛雪音源: ${config.luoxueApiUrl}`);
    } else {
      songloft.log.warn('尚未配置洛雪音源 API 位址');
    }
  }).catch((e) => {
    songloft.log.error('載入配置失敗: ' + String(e));
  });
}

/**
 * 插件卸載
 */
function onDeinit(): void {
  songloft.log.info('歌單匯入器插件已卸載');
}

/**
 * HTTP 請求處理（插件對外服務入口）
 */
function onHTTPRequest(req: HttpRequest): HttpResponse | Promise<HttpResponse> {
  // 所有 /api/ 路徑走 API 處理
  if (req.path.includes('/api/')) {
    return handleApiRequest(req);
  }
  // 其他路徑返回 404（靜態資源由 Songloft 自動託管）
  return {
    statusCode: 404,
    headers: { 'Content-Type': 'text/plain' },
    body: 'Not Found',
  };
}

// ==================== 匯出生命週期函數 ====================
// QuickJS 環境中，這些函數需要掛載到全域

const globalObj = globalThis as unknown as Record<string, unknown>;
globalObj.onInit = onInit;
globalObj.onDeinit = onDeinit;
globalObj.onHTTPRequest = onHTTPRequest;
