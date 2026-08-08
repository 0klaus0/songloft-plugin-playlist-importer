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
import { logInfo, logWarn, logError } from './logger';

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

/** 上次初始化错误信息 */
let lastInitError: string = '';

/**
 * lx 全局对象的初始化代码（注入到 jsenv 子环境中）
 *
 * 这段代码在子环境创建时执行，建立 LX 协议所需的 globalThis.lx 对象。
 * 包含浏览器 API 兼容层（window, URLSearchParams, btoa/atob 等）。
 */
const LX_INIT_CODE = `
// ===== 浏览器兼容层 =====
// LX 脚本通常在 Electron BrowserWindow 中运行，引用 window.lx
if (typeof window === 'undefined') {
  globalThis.window = globalThis;
}
if (typeof self === 'undefined') {
  globalThis.self = globalThis;
}

// URLSearchParams polyfill（QuickJS 可能缺失）
if (typeof URLSearchParams === 'undefined') {
  globalThis.URLSearchParams = function(params) {
    this._data = {};
    if (typeof params === 'string') {
      var s = params.charAt(0) === '?' ? params.substring(1) : params;
      var pairs = s.split('&');
      for (var i = 0; i < pairs.length; i++) {
        var p = pairs[i].split('=');
        if (p.length === 2) this._data[decodeURIComponent(p[0])] = decodeURIComponent(p[1]);
      }
    } else if (params && typeof params === 'object') {
      for (var k in params) {
        if (params.hasOwnProperty(k)) this._data[k] = String(params[k]);
      }
    }
    this.append = function(k, v) { this._data[k] = String(v); };
    this.get = function(k) { return this._data[k] || null; };
    this.toString = function() {
      var arr = [];
      for (var k in this._data) {
        if (this._data.hasOwnProperty(k)) arr.push(encodeURIComponent(k) + '=' + encodeURIComponent(this._data[k]));
      }
      return arr.join('&');
    };
  };
}

// btoa / atob polyfill
if (typeof btoa === 'undefined') {
  globalThis.btoa = function(str) {
    var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    var output = '';
    for (var i = 0; i < str.length; i += 3) {
      var byte1 = str.charCodeAt(i) & 0xFF;
      var byte2 = i + 1 < str.length ? str.charCodeAt(i + 1) & 0xFF : 0;
      var byte3 = i + 2 < str.length ? str.charCodeAt(i + 2) & 0xFF : 0;
      output += chars[byte1 >> 2];
      output += chars[((byte1 & 3) << 4) | (byte2 >> 4)];
      output += i + 1 < str.length ? chars[((byte2 & 15) << 2) | (byte3 >> 6)] : '=';
      output += i + 2 < str.length ? chars[byte3 & 63] : '=';
    }
    return output;
  };
}
if (typeof atob === 'undefined') {
  globalThis.atob = function(str) {
    var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    var output = '';
    var str2 = str.replace(/=+$/, '');
    for (var i = 0; i < str2.length; i += 4) {
      var n1 = chars.indexOf(str2.charAt(i));
      var n2 = chars.indexOf(str2.charAt(i + 1));
      var n3 = chars.indexOf(str2.charAt(i + 2));
      var n4 = chars.indexOf(str2.charAt(i + 3));
      output += String.fromCharCode((n1 << 2) | (n2 >> 4));
      if (n3 !== -1) output += String.fromCharCode(((n2 & 15) << 4) | (n3 >> 2));
      if (n4 !== -1) output += String.fromCharCode(((n3 & 3) << 6) | n4);
    }
    return output;
  };
}

// TextEncoder / TextDecoder polyfill（简易版）
if (typeof TextEncoder === 'undefined') {
  globalThis.TextEncoder = function() {
    this.encode = function(str) {
      var arr = [];
      for (var i = 0; i < str.length; i++) {
        var c = str.charCodeAt(i);
        if (c < 128) arr.push(c);
        else if (c < 2048) { arr.push(192 | (c >> 6)); arr.push(128 | (c & 63)); }
        else { arr.push(224 | (c >> 12)); arr.push(128 | ((c >> 6) & 63)); arr.push(128 | (c & 63)); }
      }
      return new Uint8Array(arr);
    };
  };
}
if (typeof TextDecoder === 'undefined') {
  globalThis.TextDecoder = function() {
    this.decode = function(bytes) {
      var str = '';
      for (var i = 0; i < bytes.length; i++) {
        str += String.fromCharCode(bytes[i]);
      }
      return str;
    };
  };
}

// ===== console polyfill =====
// 捕获 LX 脚本的 console 输出，通过 __go_send 转发到主环境
if (!globalThis.console) {
  globalThis.console = {};
}
var __orig_log = globalThis.console.log;
globalThis.console.log = function() {
  var args = Array.prototype.slice.call(arguments);
  var msg = args.map(function(a) {
    if (a === null) return 'null';
    if (a === undefined) return 'undefined';
    if (typeof a === 'object') { try { return JSON.stringify(a); } catch(e) { return String(a); } }
    return String(a);
  }).join(' ');
  if (typeof __go_send === 'function') {
    __go_send('console_log', JSON.stringify({ level: 'info', msg: msg.substring(0, 500) }));
  }
  if (__orig_log) __orig_log.apply(console, args);
};
globalThis.console.warn = function() {
  var args = Array.prototype.slice.call(arguments);
  var msg = args.map(function(a) {
    if (typeof a === 'object') { try { return JSON.stringify(a); } catch(e) { return String(a); } }
    return String(a);
  }).join(' ');
  if (typeof __go_send === 'function') {
    __go_send('console_log', JSON.stringify({ level: 'warn', msg: msg.substring(0, 500) }));
  }
};
globalThis.console.error = function() {
  var args = Array.prototype.slice.call(arguments);
  var msg = args.map(function(a) {
    if (typeof a === 'object') { try { return JSON.stringify(a); } catch(e) { return String(a); } }
    return String(a);
  }).join(' ');
  if (typeof __go_send === 'function') {
    __go_send('console_log', JSON.stringify({ level: 'error', msg: msg.substring(0, 500) }));
  }
};
globalThis.console.debug = globalThis.console.log;
globalThis.console.info = globalThis.console.log;

// ===== 诊断：检测关键全局变量可用性 =====
var __diag = [];
__diag.push('fetch=' + (typeof fetch !== 'undefined'));
__diag.push('Buffer=' + (typeof Buffer !== 'undefined'));
__diag.push('crypto=' + (typeof crypto !== 'undefined'));
__diag.push('crypto.createHash=' + (typeof crypto !== 'undefined' && typeof crypto.createHash === 'function'));
__diag.push('zlib=' + (typeof zlib !== 'undefined'));
__diag.push('setTimeout=' + (typeof setTimeout !== 'undefined'));
if (typeof __go_send === 'function') {
  __go_send('console_log', JSON.stringify({ level: 'info', msg: '[诊断] ' + __diag.join(', ') }));
}

// ===== LX 协议接口 =====
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
  // 标记是否已初始化
  globalThis.__lx_inited = false;
  globalThis.__lx_inited_data = null;

  // lx.on: 注册事件监听器（脚本用于接收 request 事件）
  lx.on = function(eventName, handler) {
    if (eventName === 'request') {
      globalThis.__lx_request_handler = handler;
    }
  };

  // lx.send: 发送事件（脚本用于 inited/updateAlert）
  // __go_send 是 jsenv 子环境内置的全局函数，用于向父环境发送事件
  lx.send = function(eventName, data) {
    var dataStr = typeof data === 'string' ? data : JSON.stringify(data);
    if (eventName === 'inited') {
      globalThis.__lx_inited = true;
      globalThis.__lx_inited_data = dataStr;
    }
    if (typeof __go_send === 'function') {
      __go_send(eventName, dataStr);
    }
  };

  // lx.request: HTTP 请求（回调风格，不受跨域限制）
  // LX 脚本使用此方法发起网络请求
  lx.request = function(url, options, callback) {
    if (typeof __go_send === 'function') {
      __go_send('console_log', JSON.stringify({ level: 'info', msg: '[lx.request] ' + ((options||{}).method||'GET') + ' ' + url.substring(0, 200) }));
    }
    var opts = options || {};
    var method = (opts.method || 'GET').toUpperCase();
    var headers = opts.headers || {};
    var body = null;

    if (opts.body) {
      body = opts.body;
    } else if (opts.formData) {
      var parts = [];
      for (var k in opts.formData) {
        if (opts.formData.hasOwnProperty(k)) {
          parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(opts.formData[k])));
        }
      }
      body = parts.join('&');
      headers['Content-Type'] = headers['Content-Type'] || 'application/x-www-form-urlencoded';
    } else if (opts.json) {
      body = JSON.stringify(opts.json);
      headers['Content-Type'] = headers['Content-Type'] || 'application/json';
    } else if (opts.form) {
      var parts2 = [];
      for (var k2 in opts.form) {
        if (opts.form.hasOwnProperty(k2)) {
          parts2.push(encodeURIComponent(k2) + '=' + encodeURIComponent(String(opts.form[k2])));
        }
      }
      body = parts2.join('&');
      headers['Content-Type'] = headers['Content-Type'] || 'application/x-www-form-urlencoded';
    }

    var fetchOpts = { method: method, headers: headers };
    if (body && method !== 'GET' && method !== 'HEAD') {
      fetchOpts.body = body;
    }

    fetch(url, fetchOpts).then(function(resp) {
      return resp.text().then(function(text) {
        if (typeof __go_send === 'function') {
          __go_send('console_log', JSON.stringify({ level: 'info', msg: '[lx.request] 响应 ' + resp.status + ' ' + url.substring(0, 100) + ' body=' + text.substring(0, 300) }));
        }
        var respHeaders = {};
        if (resp.headers && typeof resp.headers.forEach === 'function') {
          resp.headers.forEach(function(v, k) { respHeaders[k] = v; });
        }
        // 尝试解析 JSON
        var parsedBody = text;
        try {
          var ct = (respHeaders['content-type'] || respHeaders['Content-Type'] || '');
          if (ct.indexOf('json') >= 0 || (text.charAt(0) === '{' || text.charAt(0) === '[')) {
            parsedBody = JSON.parse(text);
          }
        } catch(e) { /* 保持 text */ }
        callback(null, { statusCode: resp.status, status: resp.status, body: parsedBody, headers: respHeaders, raw: text }, parsedBody);
      });
    }).catch(function(err) {
      if (typeof __go_send === 'function') {
        __go_send('console_log', JSON.stringify({ level: 'error', msg: '[lx.request] 请求失败 ' + url.substring(0, 100) + ' err=' + String(err).substring(0, 200) }));
      }
      callback(err, null, null);
    });
  };

  // lx.utils: 工具方法
  if (!lx.utils) lx.utils = {};

  lx.utils.crypto = lx.utils.crypto || {
    md5: function(s) {
      try {
        if (typeof crypto !== 'undefined' && crypto.createHash) {
          return crypto.createHash('md5').update(s).digest('hex');
        }
        if (typeof require === 'function') {
          return require('crypto').createHash('md5').update(s).digest('hex');
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
        var arr = new Uint8Array(n);
        for (var i = 0; i < n; i++) arr[i] = Math.floor(Math.random() * 256);
        return Buffer.from(arr);
      } catch(e) {
        var arr2 = new Uint8Array(n);
        for (var j = 0; j < n; j++) arr2[j] = Math.floor(Math.random() * 256);
        return Buffer.from(arr2);
      }
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

  lx.utils.buffer = lx.utils.buffer || {
    from: function() { return Buffer.from.apply(Buffer, arguments); },
    bufToString: function(buf, format) { return buf.toString(format); },
    alloc: function(n) { return Buffer.alloc(n); },
  };

  lx.utils.zlib = lx.utils.zlib || {
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

  lx.utils.log = lx.utils.log || function() {
    if (typeof console !== 'undefined' && console.log) {
      console.log.apply(console, arguments);
    }
  };

  // Promise
  lx.Promise = lx.Promise || Promise;

  // HTTP 请求快捷方法（部分脚本可能直接使用 lx.utils.fetch）
  if (!lx.utils.fetch) {
    lx.utils.fetch = function(url, options) {
      return fetch(url, options || {});
    };
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

  logInfo(`下载音源脚本: ${url}`);
  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });

    if (!resp.ok) {
      logWarn(`下载音源脚本失败: HTTP ${resp.status}`);
      lastInitError = `下载失败: HTTP ${resp.status}`;
      return null;
    }

    const text = await resp.text();
    if (!text || text.length < 100) {
      logWarn('音源脚本内容过短，可能无效');
      lastInitError = '脚本内容过短';
      return null;
    }

    scriptCache.set(url, text);
    logInfo(`音源脚本下载成功 (${text.length} 字节)`);
    return text;
  } catch (e) {
    logError(`下载音源脚本异常: ${String(e)}`);
    lastInitError = `下载异常: ${String(e)}`;
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
    // 销毁旧环境（无论 envReady 状态，都先尝试销毁，避免 "already exists" 错误）
    try {
      await songloft.jsenv.destroy(ENV_NAME);
    } catch {
      // 环境不存在时忽略错误
    }
    envReady = false;
    loadedScriptUrl = null;

    // 创建新环境，注入 lx 初始化代码
    logInfo('创建 jsenv 子环境...');
    await songloft.jsenv.create(ENV_NAME, LX_INIT_CODE);

    // 加载音源脚本并等待 inited 事件
    logInfo('加载音源脚本，等待初始化...');
    const result = await songloft.jsenv.executeWait(
      ENV_NAME,
      scriptCode,
      30000,
      ['inited', 'updateAlert']
    );

    if (result.error) {
      logError(`音源脚本执行错误: ${result.error}`);
      lastInitError = `脚本执行错误: ${result.error}`;
      return false;
    }

    // 收集并输出初始化阶段的 console_log 事件
    const initConsoleLogs = result.events.filter(e => e.name === 'console_log');
    for (const cl of initConsoleLogs) {
      try {
        const clData = JSON.parse(cl.data);
        if (clData.level === 'error' || clData.level === 'warn') {
          logWarn(`[音源脚本] ${clData.msg}`);
        } else {
          logInfo(`[音源脚本] ${clData.msg}`);
        }
      } catch {
        // ignore
      }
    }

    // 解析 inited 事件，获取支持的来源
    const initedEvent = result.events.find(e => e.name === 'inited');
    if (!initedEvent) {
      logWarn('音源脚本未发送 inited 事件（可能初始化失败）');
      lastInitError = '脚本未发送 inited 事件';
      // 打印 result.result 帮助调试
      logWarn(`脚本执行结果: ${(result.result || '').substring(0, 200)}`);
      if (result.events.length > 0) {
        logWarn(`收到的事件: ${result.events.map(e => e.name).join(', ')}`);
      }
      return false;
    }

    try {
      const initedData = JSON.parse(initedEvent.data);
      if (initedData.status === false) {
        logError('音源脚本初始化失败: status=false');
        lastInitError = '脚本初始化失败 (status=false)';
        return false;
      }
      if (initedData.sources) {
        supportedSources = Object.keys(initedData.sources);
        logInfo(`音源脚本已初始化，支持来源: ${supportedSources.join(', ')}`);
      } else {
        supportedSources = ['kw', 'kg', 'tx', 'wy', 'mg'];
        logInfo('音源脚本已初始化（未声明来源，默认全部支持）');
      }
      lastInitError = '';
    } catch {
      supportedSources = ['kw', 'kg', 'tx', 'wy', 'mg'];
      logInfo('音源脚本已初始化（来源解析失败，默认全部支持）');
      lastInitError = '';
    }

    envReady = true;
    loadedScriptUrl = scriptUrl;
    return true;
  } catch (e) {
    logError(`初始化音源环境失败: ${String(e)}`);
    lastInitError = `初始化失败: ${String(e)}`;
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
    logWarn('音源环境未初始化');
    return null;
  }

  // 构造请求代码
  // 通过 __lx_request_handler 调用脚本注册的处理器
  // 处理器返回 Promise<string>（URL），我们将结果通过 __go_send 发送回主环境
  //
  // musicInfo 包含所有平台可能的 ID 字段，确保不同来源的脚本都能找到所需 ID：
  // - songmid: QQ音乐 (tx)
  // - hash: 酷狗音乐 (kg)
  // - songId / id: 网易云音乐 (wy)
  // - musicId / rid: 酷我音乐 (kw)
  // - copyrightId: 咪咕音乐 (mg)
  const requestCode = `
(function() {
  var handler = globalThis.__lx_request_handler;
  if (!handler) {
    __go_send('musicUrl_error', JSON.stringify({ error: 'no request handler registered' }));
    return;
  }
  var req = {
    source: ${JSON.stringify(source)},
    action: 'musicUrl',
    info: {
      type: ${JSON.stringify(quality)},
      quality: ${JSON.stringify(quality)},
      musicInfo: {
        songmid: ${JSON.stringify(songId)},
        hash: ${JSON.stringify(songId)},
        songId: ${JSON.stringify(songId)},
        id: ${JSON.stringify(songId)},
        musicId: ${JSON.stringify(songId)},
        rid: ${JSON.stringify(songId)},
        copyrightId: ${JSON.stringify(songId)}
      }
    }
  };
  try {
    var result = handler(req);
    if (result && typeof result.then === 'function') {
      result.then(function(url) {
        __go_send('musicUrl_result', JSON.stringify({ url: String(url) }));
      }).catch(function(err) {
        var errInfo = {
          message: err && err.message ? err.message : String(err),
          stack: err && err.stack ? String(err.stack).substring(0, 500) : '',
          name: err && err.name ? err.name : ''
        };
        __go_send('musicUrl_error', JSON.stringify(errInfo));
      });
    } else {
      __go_send('musicUrl_result', JSON.stringify({ url: String(result || '') }));
    }
  } catch(e) {
    var errInfo2 = {
      message: e && e.message ? e.message : String(e),
      stack: e && e.stack ? String(e.stack).substring(0, 500) : '',
      name: e && e.name ? e.name : ''
    };
    __go_send('musicUrl_error', JSON.stringify(errInfo2));
  }
})();
`;

  try {
    logInfo(`发送音源请求: ${source}/${songId} (音质=${quality})`);
    const result = await songloft.jsenv.executeWait(
      ENV_NAME,
      requestCode,
      30000,
      ['musicUrl_result', 'musicUrl_error']
    );

    if (result.error) {
      logWarn(`音源请求执行错误: ${result.error}`);
      return null;
    }

    // 收集并输出 console_log 事件（脚本调试输出）
    const consoleLogs = result.events.filter(e => e.name === 'console_log');
    for (const cl of consoleLogs) {
      try {
        const clData = JSON.parse(cl.data);
        if (clData.level === 'error') {
          logWarn(`[音源脚本] ${clData.msg}`);
        } else if (clData.level === 'warn') {
          logWarn(`[音源脚本] ${clData.msg}`);
        } else {
          logInfo(`[音源脚本] ${clData.msg}`);
        }
      } catch {
        // ignore
      }
    }

    // 查找结果事件
    const successEvent = result.events.find(e => e.name === 'musicUrl_result');
    if (successEvent) {
      const data = JSON.parse(successEvent.data);
      if (data.url && data.url.startsWith('http')) {
        logInfo(`音源解析成功: ${source}/${songId} → ${data.url.substring(0, 80)}...`);
        return data.url;
      }
      logWarn(`音源返回的 URL 无效: ${data.url}`);
      return null;
    }

    const errorEvent = result.events.find(e => e.name === 'musicUrl_error');
    if (errorEvent) {
      const data = JSON.parse(errorEvent.data);
      const errMsg = data.message || data.error || 'unknown';
      const errStack = data.stack ? ` | stack: ${data.stack.substring(0, 200)}` : '';
      const errName = data.name ? ` [${data.name}]` : '';
      logWarn(`音源解析失败: ${source}/${songId} - ${errName}${errMsg}${errStack}`);
      return null;
    }

    logWarn('音源请求超时，未收到响应');
    return null;
  } catch (e) {
    logError(`音源请求异常: ${String(e)}`);
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
      logWarn(`音源脚本初始化失败，尝试下一个: ${scriptUrl}`);
      continue;
    }

    // 检查脚本是否支持此来源
    if (supportedSources.length > 0 && !supportedSources.includes(source)) {
      logWarn(`音源脚本不支持来源 ${source}，支持: ${supportedSources.join(',')}`);
      continue;
    }

    // 请求 URL
    const url = await requestMusicUrl(source, songId, quality);
    if (url) {
      return url;
    }

    logWarn(`音源脚本 ${scriptUrl} 未能解析 URL，尝试下一个`);
  }

  return null;
}

/**
 * 获取上次初始化错误信息
 */
export function getLastError(): string {
  return lastInitError;
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
        const err = lastInitError || '未知错误';
        results.push(`#${i + 1} 失败 (${err.substring(0, 40)})`);
        allOk = false;
      }
    } catch (e) {
      results.push(`#${i + 1} 异常: ${String(e).substring(0, 40)}`);
      allOk = false;
    }
  }

  return {
    ok: allOk,
    message: `${urls.length} 个音源: ${results.join('，')}`,
  };
}
