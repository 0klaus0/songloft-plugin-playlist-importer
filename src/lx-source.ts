/**
 * 洛雪音源脚本执行器 — 使用 Songloft jsenv 子环境加载和执行自定义音源脚本
 *
 * 工作原理：
 * 1. 下载用户提供的洛雪音源脚本（.js 文件）
 * 2. 在 songloft.jsenv 子环境中创建 lx 全局对象（LX 协议接口）
 * 3. 加载音源脚本，等待 inited 事件确认初始化成功
 * 4. 通过 request 事件向脚本请求音乐 URL
 * 5. 返回直接 URL 供 Songloft 创建远程歌曲
 *
 * LX 音源脚本协议：
 * - 脚本通过 lx.on('request', handler) 注册请求处理器
 * - 脚本通过 lx.send('inited', { sources }) 声明初始化完成
 * - 请求格式: { source, action: 'musicUrl', info: { type, musicInfo: { songmid } } }
 * - 响应格式: Promise<string>（解析为音乐 URL）
 */
/// <reference types="@songloft/plugin-sdk" />

/** jsenv 环境名称 */
const ENV_NAME = 'lxsource';

/** 脚本缓存：URL → 脚本内容 */
const scriptCache = new Map<string, string>();

/** 当前已加载的脚本 URL */
let loadedScriptUrl: string | null = null;

/** 当前音源支持的来源列表 */
let supportedSources: string[] = [];

/** 是否已初始化环境 */
let envReady = false;

/**
 * lx 全局对象的初始化代码（注入到 jsenv 子环境中）
 *
 * 这段代码在子环境创建时执行，建立 LX 协议所需的 globalThis.lx 对象。
 * 如果 Songloft 已内置 lx 对象，则仅补充缺失的方法。
 */
const LX_INIT_CODE = `
(function() {
  if (!globalThis.lx) {
    globalThis.lx = {};
  }
  var lx = globalThis.lx;

  lx.EVENT_NAMES = lx.EVENT_NAMES || { request: 'request', inited: 'inited', updateAlert: 'updateAlert' };
  lx.env = lx.env || 'desktop';
  lx.version = lx.version || '2.0.0';
  lx.currentScriptInfo = lx.currentScriptInfo || { name: '', description: '', version: '', author: '', homepage: '', rawScript: '' };

  // 存储请求处理器
  globalThis.__lx_request_handler = null;

  // lx.on: 注册事件监听器（脚本用于接收 request 事件）
  if (!lx.on || lx._wrapped_on !== true) {
    lx._wrapped_on = true;
    lx.on = function(eventName, handler) {
      if (eventName === 'request') {
        globalThis.__lx_request_handler = handler;
      }
    };
  }

  // lx.send: 发送事件（脚本用于 inited/updateAlert）
  if (!lx.send) {
    lx.send = function(eventName, data) {
      if (typeof __go_send === 'function') {
        __go_send(eventName, typeof data === 'string' ? data : JSON.stringify(data));
      }
    };
  }

  // lx.request: HTTP 请求（回调风格，不受跨域限制）
  if (!lx.request) {
    lx.request = function(url, options, callback) {
      var opts = options || {};
      var fetchOpts = { method: opts.method || 'GET', headers: opts.headers || {} };

      if (opts.body) {
        fetchOpts.body = opts.body;
      }
      if (opts.formData) {
        var params = new URLSearchParams();
        for (var k in opts.formData) {
          if (opts.formData.hasOwnProperty(k)) params.append(k, String(opts.formData[k]));
        }
        fetchOpts.body = params;
        fetchOpts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
      }
      if (opts.json) {
        fetchOpts.body = JSON.stringify(opts.json);
        fetchOpts.headers['Content-Type'] = 'application/json';
      }

      fetch(url, fetchOpts).then(function(resp) {
        return resp.text().then(function(body) {
          var headers = {};
          if (resp.headers && typeof resp.headers.forEach === 'function') {
            resp.headers.forEach(function(v, k) { headers[k] = v; });
          }
          callback(null, { statusCode: resp.status, body: body, headers: headers }, body);
        });
      }).catch(function(err) {
        callback(err, null, null);
      });
    };
  }

  // lx.utils: 工具方法
  if (!lx.utils) lx.utils = {};

  if (!lx.utils.crypto) {
    lx.utils.crypto = {
      md5: function(s) {
        try {
          if (typeof crypto !== 'undefined' && crypto.createHash) {
            return crypto.createHash('md5').update(s).digest('hex');
          }
          return '';
        } catch(e) { return ''; }
      },
      sha256: function(s) {
        try {
          if (typeof crypto !== 'undefined' && crypto.createHash) {
            return crypto.createHash('sha256').update(s).digest('hex');
          }
          return '';
        } catch(e) { return ''; }
      },
      sha1: function(s) {
        try {
          if (typeof crypto !== 'undefined' && crypto.createHash) {
            return crypto.createHash('sha1').update(s).digest('hex');
          }
          return '';
        } catch(e) { return ''; }
      },
      randomBytes: function(n) {
        try {
          if (typeof crypto !== 'undefined' && crypto.randomBytes) {
            return crypto.randomBytes(n);
          }
          return Buffer.alloc(n);
        } catch(e) { return Buffer.alloc(n); }
      },
      aesEncrypt: function(data, mode, data2, key, iv) {
        try {
          if (typeof crypto !== 'undefined' && crypto.createCipheriv) {
            var cipher = crypto.createCipheriv(mode, key, iv);
            return Buffer.concat([cipher.update(data), cipher.final()]);
          }
          return null;
        } catch(e) { return null; }
      },
      rsaEncrypt: function(data, key) {
        try {
          if (typeof crypto !== 'undefined' && crypto.publicEncrypt) {
            return crypto.publicEncrypt(key, data);
          }
          return null;
        } catch(e) { return null; }
      },
    };
  }

  if (!lx.utils.buffer) {
    lx.utils.buffer = {
      from: function() { return Buffer.from.apply(Buffer, arguments); },
      bufToString: function(buf, format) { return buf.toString(format); },
    };
  }

  if (!lx.utils.zlib) {
    lx.utils.zlib = {
      gzip: function(data) {
        try { return zlib.gzipSync(data); } catch(e) { return null; }
      },
      gunzip: function(data) {
        try { return zlib.gunzipSync(data); } catch(e) { return null; }
      },
      deflate: function(data) {
        try { return zlib.deflateSync(data); } catch(e) { return null; }
      },
      inflate: function(data) {
        try { return zlib.inflateSync(data); } catch(e) { return null; }
      },
    };
  }

  // Promise 等待工具（供脚本内部使用）
  if (!lx.Promise) {
    lx.Promise = Promise;
  }
})();
`;

/**
 * 下载音源脚本内容
 */
async function downloadScript(url: string): Promise<string | null> {
  // 检查缓存
  if (scriptCache.has(url)) {
    return scriptCache.get(url)!;
  }

  songloft.log.info(`下载音源脚本: ${url}`);
  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });

    if (!resp.ok) {
      songloft.log.warn(`下载音源脚本失败: HTTP ${resp.status}`);
      return null;
    }

    const text = await resp.text();
    if (!text || text.length < 100) {
      songloft.log.warn('音源脚本内容过短，可能无效');
      return null;
    }

    scriptCache.set(url, text);
    songloft.log.info(`音源脚本下载成功 (${text.length} 字节)`);
    return text;
  } catch (e) {
    songloft.log.error(`下载音源脚本异常: ${String(e)}`);
    return null;
  }
}

/**
 * 初始化 jsenv 环境并加载音源脚本
 *
 * @param scriptUrl 音源脚本 URL
 * @returns 是否成功初始化
 */
async function initEnv(scriptUrl: string): Promise<boolean> {
  // 如果已经加载了同一个脚本，直接返回
  if (envReady && loadedScriptUrl === scriptUrl) {
    return true;
  }

  // 下载脚本
  const scriptCode = await downloadScript(scriptUrl);
  if (!scriptCode) {
    return false;
  }

  try {
    // 销毁旧环境（如果存在）
    if (envReady) {
      try {
        await songloft.jsenv.destroy(ENV_NAME);
      } catch {
        // 忽略错误
      }
      envReady = false;
      loadedScriptUrl = null;
    }

    // 创建新环境，注入 lx 初始化代码
    songloft.log.info('创建 jsenv 子环境...');
    await songloft.jsenv.create(ENV_NAME, LX_INIT_CODE);

    // 加载音源脚本并等待 inited 事件
    songloft.log.info('加载音源脚本，等待初始化...');
    const result = await songloft.jsenv.executeWait(
      ENV_NAME,
      scriptCode,
      30000,
      ['inited']
    );

    if (result.error) {
      songloft.log.error(`音源脚本执行错误: ${result.error}`);
      return false;
    }

    // 解析 inited 事件，获取支持的来源
    const initedEvent = result.events.find(e => e.name === 'inited');
    if (!initedEvent) {
      songloft.log.warn('音源脚本未发送 inited 事件');
      return false;
    }

    try {
      const initedData = JSON.parse(initedEvent.data);
      if (initedData.status === false) {
        songloft.log.error('音源脚本初始化失败');
        return false;
      }
      if (initedData.sources) {
        supportedSources = Object.keys(initedData.sources);
        songloft.log.info(`音源脚本已初始化，支持来源: ${supportedSources.join(', ')}`);
      } else {
        supportedSources = ['kw', 'kg', 'tx', 'wy', 'mg'];
        songloft.log.info('音源脚本已初始化（未声明来源，默认全部支持）');
      }
    } catch {
      supportedSources = ['kw', 'kg', 'tx', 'wy', 'mg'];
      songloft.log.info('音源脚本已初始化（来源解析失败，默认全部支持）');
    }

    envReady = true;
    loadedScriptUrl = scriptUrl;
    return true;
  } catch (e) {
    songloft.log.error(`初始化音源环境失败: ${String(e)}`);
    return false;
  }
}

/**
 * 通过音源脚本请求音乐 URL
 *
 * @param source 音源标识（kw/kg/tx/wy/mg）
 * @param songId 歌曲 ID
 * @param quality 音质（128k/320k/flac/flac24bit）
 * @returns 音乐 URL 或 null
 */
async function requestMusicUrl(
  source: string,
  songId: string,
  quality: string
): Promise<string | null> {
  if (!envReady) {
    songloft.log.warn('音源环境未初始化');
    return null;
  }

  // 构造请求代码
  // 通过 __lx_request_handler 调用脚本注册的处理器
  // 处理器返回 Promise<string>（URL），我们将结果通过 __go_send 发送回主环境
  const requestCode = `
(function() {
  var handler = globalThis.__lx_request_handler;
  if (!handler) {
    __go_send('musicUrl_error', JSON.stringify({ error: 'no request handler' }));
    return;
  }
  var req = {
    source: ${JSON.stringify(source)},
    action: 'musicUrl',
    info: {
      type: ${JSON.stringify(quality)},
      musicInfo: {
        songmid: ${JSON.stringify(songId)},
        hash: ${JSON.stringify(songId)},
        songId: ${JSON.stringify(songId)},
        id: ${JSON.stringify(songId)}
      }
    }
  };
  try {
    var result = handler(req);
    if (result && typeof result.then === 'function') {
      result.then(function(url) {
        __go_send('musicUrl_result', JSON.stringify({ url: String(url) }));
      }).catch(function(err) {
        __go_send('musicUrl_error', JSON.stringify({ error: String(err) }));
      });
    } else {
      __go_send('musicUrl_result', JSON.stringify({ url: String(result || '') }));
    }
  } catch(e) {
    __go_send('musicUrl_error', JSON.stringify({ error: String(e) }));
  }
})();
`;

  try {
    const result = await songloft.jsenv.executeWait(
      ENV_NAME,
      requestCode,
      30000,
      ['musicUrl_result', 'musicUrl_error']
    );

    if (result.error) {
      songloft.log.warn(`音源请求执行错误: ${result.error}`);
      return null;
    }

    // 查找结果事件
    const successEvent = result.events.find(e => e.name === 'musicUrl_result');
    if (successEvent) {
      const data = JSON.parse(successEvent.data);
      if (data.url && data.url.startsWith('http')) {
        songloft.log.info(`音源解析成功: ${source}/${songId} → ${data.url.substring(0, 80)}...`);
        return data.url;
      }
      songloft.log.warn(`音源返回的 URL 无效: ${data.url}`);
      return null;
    }

    const errorEvent = result.events.find(e => e.name === 'musicUrl_error');
    if (errorEvent) {
      const data = JSON.parse(errorEvent.data);
      songloft.log.warn(`音源解析失败: ${source}/${songId} - ${data.error}`);
      return null;
    }

    songloft.log.warn('音源请求超时，未收到响应');
    return null;
  } catch (e) {
    songloft.log.error(`音源请求异常: ${String(e)}`);
    return null;
  }
}

/**
 * 使用自定义音源脚本解析音乐 URL
 *
 * 遍历用户配置的所有音源脚本 URL，逐个尝试初始化并请求 URL。
 * 第一个成功返回有效 URL 的脚本即为最终结果。
 *
 * @param customSourceUrls 自定义音源脚本 URL 列表
 * @param source 音源标识（kw/kg/tx/wy/mg）
 * @param songId 歌曲 ID
 * @param quality 音质
 * @returns 音乐 URL 或 null
 */
export async function resolveUrlWithCustomSource(
  customSourceUrls: string[],
  source: string,
  songId: string,
  quality: string
): Promise<string | null> {
  const urls = customSourceUrls
    .map(u => u.trim())
    .filter(u => u.length > 0);

  if (urls.length === 0) {
    return null;
  }

  // 逐个尝试音源脚本
  for (const scriptUrl of urls) {
    // 初始化环境（如果尚未加载此脚本）
    const ok = await initEnv(scriptUrl);
    if (!ok) {
      songloft.log.warn(`音源脚本初始化失败，尝试下一个: ${scriptUrl}`);
      continue;
    }

    // 检查脚本是否支持此来源
    if (supportedSources.length > 0 && !supportedSources.includes(source)) {
      songloft.log.warn(`音源脚本不支持来源 ${source}，支持: ${supportedSources.join(',')}`);
      continue;
    }

    // 请求 URL
    const url = await requestMusicUrl(source, songId, quality);
    if (url) {
      return url;
    }

    songloft.log.warn(`音源脚本 ${scriptUrl} 未能解析 URL，尝试下一个`);
  }

  return null;
}

/**
 * 检查自定义音源脚本是否已就绪
 */
export function isCustomSourceReady(): boolean {
  return envReady;
}

/**
 * 清理资源（销毁 jsenv）
 */
export async function cleanup(): Promise<void> {
  if (envReady) {
    try {
      await songloft.jsenv.destroy(ENV_NAME);
    } catch {
      // 忽略
    }
    envReady = false;
    loadedScriptUrl = null;
    supportedSources = [];
  }
}

/**
 * 测试音源脚本连通性
 *
 * @param scriptUrls 音源脚本 URL 列表
 * @returns 测试结果
 */
export async function testCustomSources(
  scriptUrls: string[]
): Promise<{ ok: boolean; message: string }> {
  const urls = scriptUrls.map(u => u.trim()).filter(u => u.length > 0);

  if (urls.length === 0) {
    return { ok: false, message: '未配置音源脚本' };
  }

  const results: string[] = [];
  let allOk = true;

  for (let i = 0; i < urls.length; i++) {
    try {
      const ok = await initEnv(urls[i]);
      if (ok) {
        const sources = supportedSources.length > 0 ? supportedSources.join(',') : '全部';
        results.push(`#${i + 1} 正常 (${sources})`);
      } else {
        results.push(`#${i + 1} 初始化失败`);
        allOk = false;
      }
    } catch (e) {
      results.push(`#${i + 1} 异常: ${String(e)}`);
      allOk = false;
    }
  }

  return {
    ok: allOk,
    message: `${urls.length} 个音源: ${results.join('，')}`,
  };
}
