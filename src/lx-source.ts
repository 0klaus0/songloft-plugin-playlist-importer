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
 *
 * ★ 关于并发与 jsenv 环境：
 *   songloft.jsenv 子环境是单事件流的，同一时刻只应有一个请求活跃。
 *   但本插件的阶段 1（预解析音源 URL）本身是**顺序执行**的，阶段 2 的
 *   并发（songloft.songs.create / download）不再触碰 jsenv，因此
 *   initEnv / requestMusicUrl 无需额外互斥锁即可安全运行。
 *   （早期版本曾加 mutex 锁，实测反而导致取 URL 失败，已移除。）
 */
/// <reference types="@songloft/plugin-sdk" />
import { logInfo, logWarn, logError } from './logger';
import { getUploadedSource } from './config';
import { CustomSource, ALL_LX_SOURCES, LX_SOURCE_NAMES, PlatformStatus, LXSource } from './types';
import { searchMusic as searchOnPlatform } from './fetchers';

/** jsenv 环境名称 */
const ENV_NAME = 'lxsource';

/** 脚本缓存：标识（URL 或文件 id）→ 脚本内容 */
const scriptCache = new Map<string, string>();

/** 当前已加载的脚本标识 */
let loadedScriptName: string | null = null;

/**
 * 音源描述符：一个可加载的音源脚本（URL 或本地上传文件）
 * - name: 展示名（URL 或文件名）
 * - load: 返回脚本内容；加载失败返回 null
 */
export interface SourceDescriptor {
  name: string;
  load: () => Promise<string | null>;
}

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
 * 根据 CustomSource 描述加载脚本内容（URL 下载 或 读取本地上传文件）
 */
export async function loadSourceContent(source: CustomSource): Promise<string | null> {
  if (source.kind === 'file') {
    const f = await getUploadedSource(source.value);
    if (!f || !f.content) {
      logWarn(`读取上传音源文件失败: ${source.name} (id=${source.value})`);
      return null;
    }
    return f.content;
  }
  return downloadScript(source.value);
}

/**
 * 下载音源脚本内容（URL 方式）
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
 * 初始化 jsenv 环境并加载音源脚本内容
 *
 * @param scriptCode 音源脚本源码
 * @param name 脚本标识（URL 或文件名），用于环境复用判断
 */
async function initEnv(scriptCode: string, name: string): Promise<boolean> {
  // 如果已经加载了同一个脚本，直接返回
  if (envReady && loadedScriptName === name) {
    logInfo(`音源环境已就绪，复用现有环境: ${name.substring(0, 60)}...`);
    return true;
  }

  logInfo(`initEnv: envReady=${envReady}, loadedScriptName=${loadedScriptName ? loadedScriptName.substring(0, 40) : 'null'}, name=${name.substring(0, 40)}...`);

  if (!scriptCode || scriptCode.length < 100) {
    logWarn('音源脚本内容过短或为空，可能无效');
    lastInitError = '脚本内容过短';
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
    loadedScriptName = null;

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
    loadedScriptName = name;
    logInfo('音源环境初始化完成，后续歌曲将复用此环境');
    return true;
  } catch (e) {
    logError(`初始化音源环境失败: ${String(e)}`);
    lastInitError = `初始化失败: ${String(e)}`;
    return false;
  }
}

/**
 * 构造音源 URL 请求代码
 *
 * musicInfo 包含所有平台可能的 ID 字段，确保不同来源的脚本都能找到所需 ID：
 * - songmid: QQ音乐 (tx)
 * - hash: 酷狗音乐 (kg)
 * - songId / id: 网易云音乐 (wy)
 * - musicId / rid: 酷我音乐 (kw)
 * - copyrightId: 咪咕音乐 (mg)
 */
function buildRequestCode(source: string, songId: string, quality: string): string {
  return `
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
}

/**
 * 通过音源脚本请求音乐 URL
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

    const requestCode = buildRequestCode(source, songId, quality);

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
        // 环境可能已失效，标记为需要重新初始化
        envReady = false;
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
        try {
          const data = JSON.parse(successEvent.data);
          if (data.url && data.url.startsWith('http')) {
            logInfo(`音源解析成功: ${source}/${songId} → ${data.url.substring(0, 80)}...`);
            return data.url;
          }
          logWarn(`音源返回的 URL 无效: ${data.url}`);
          return null;
        } catch (e) {
          logWarn(`音源结果解析失败: ${String(e)} (data=${successEvent.data.substring(0, 200)})`);
          return null;
        }
      }

      const errorEvent = result.events.find(e => e.name === 'musicUrl_error');
      if (errorEvent) {
        try {
          const data = JSON.parse(errorEvent.data);
          const errMsg = data.message || data.error || 'unknown';
          const errStack = data.stack ? ` | stack: ${data.stack.substring(0, 200)}` : '';
          const errName = data.name ? ` [${data.name}]` : '';
          logWarn(`音源解析失败: ${source}/${songId} - ${errName}${errMsg}${errStack}`);
          logWarn(`提示：若所有歌曲都如此，多半是音源后端服务不可用（如 lxmusicapi.onrender.com 被停用），请检查音源脚本硬编码的 API 地址，或在设置中“测试音源连通性”`);
          return null;
        } catch (e) {
          logWarn(`音源错误解析失败: ${String(e)}`);
          return null;
        }
      }

      logWarn('音源请求超时，未收到响应');
      return null;
    } catch (e) {
      logError(`音源请求异常: ${String(e)}`);
      // 环境可能已失效，标记为需要重新初始化
      envReady = false;
      return null;
    }
}

/**
 * 使用自定义音源脚本解析音乐 URL
 *
 * 阶段 1 顺序调用本函数，initEnv / requestMusicUrl 均为顺序执行，
 * 无需额外互斥锁。
 *
 * @param sources 音源描述符列表（已加载内容或按需加载）
 * @param source 洛雪来源（kw/kg/tx/wy/mg）
 * @param songId 歌曲 ID
 * @param quality 音质
 */
export async function resolveUrlWithCustomSource(
  sources: SourceDescriptor[],
  source: string,
  songId: string,
  quality: string
): Promise<string | null> {
  const valid = sources.filter(s => s && s.name);
  if (valid.length === 0) {
    return null;
  }

  // 优先复用当前已加载的音源环境
  if (envReady && loadedScriptName) {
    const supportsSource = supportedSources.length === 0 || supportedSources.includes(source);
    if (supportsSource) {
      logInfo(`复用当前音源环境: ${loadedScriptName.substring(0, 50)}...`);
      const url = await requestMusicUrl(source, songId, quality);
      if (url) {
        return url;
      }
      logWarn(`当前音源脚本解析失败，尝试其他脚本: ${source}/${songId}`);
    } else {
      logInfo(`当前音源脚本不支持来源 ${source}，切换其他脚本`);
    }
  }

  // 逐个尝试其他音源脚本（跳过已加载的当前脚本）
  for (const desc of valid) {
    // 跳过已加载并已尝试过的当前脚本
    if (envReady && loadedScriptName === desc.name) {
      logInfo(`跳过已尝试的当前脚本: ${desc.name.substring(0, 40)}...`);
      continue;
    }

    // 加载脚本内容
    const scriptCode = await desc.load();
    if (!scriptCode) {
      logWarn(`音源脚本加载失败，尝试下一个: ${desc.name}`);
      continue;
    }
    scriptCache.set(desc.name, scriptCode);

    // 初始化环境（如果尚未加载此脚本）
    const ok = await initEnv(scriptCode, desc.name);
    if (!ok) {
      logWarn(`音源脚本初始化失败，尝试下一个: ${desc.name}`);
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

    logWarn(`音源脚本 ${desc.name} 未能解析 URL，尝试下一个`);
  }

  return null;
}

/**
 * 取得当前已加载脚本声明支持的来源列表
 * （脚本未声明时返回空数组，表示“未知/全部”）
 */
export function getLoadedSupportedSources(): string[] {
  return supportedSources.slice();
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
    loadedScriptName = null;
    supportedSources = [];
  }
}

/**
 * 从音源脚本源码中提取可能的后端 URL，用于在“取URL失败”时提示用户
 * 到底是哪个后端服务不可用（例如 huibq/latest.js 硬编码的
 * https://lxmusicapi.onrender.com）。会过滤掉明显的仓库地址（github.com）。
 */
function extractBackendUrls(scriptText: string | undefined): string[] {
  if (!scriptText) return [];
  const urls = scriptText.match(/https?:\/\/[^\s"'`)>]+/g) || [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of urls) {
    if (/github\.com/i.test(u)) continue;
    const base = u.replace(/\/+$/, '');
    if (!seen.has(base)) {
      seen.add(base);
      out.push(base);
    }
  }
  return out;
}

/**
 * 测试音源脚本连通性（快速检查：脚本能否加载 + 一个来源能否取到 URL）
 *
 * @param sources 音源描述符列表
 * @returns 测试结果
 */
export async function testCustomSources(
  sources: SourceDescriptor[]
): Promise<{ ok: boolean; message: string }> {
  const valid = sources.filter(s => s && s.name);

  if (valid.length === 0) {
    return { ok: false, message: '未配置音源脚本' };
  }

  const results: string[] = [];
  let allOk = true;

  // 探针：用一首稳定存在的酷我曲目（Justin Bieber - Beauty And A Beat）
  // 真实发起一次取 URL 请求，而不仅仅是验证脚本能否加载。
  // 目的：暴露「脚本能加载，但后端服务不可用」这类问题
  // （例如 lxmusicapi.onrender.com 被所有者暂停，会返回 503，
  //  单看 initEnv 成功会误导用户以为音源正常）。
  const PROBE_SOURCE = 'kw';
  const PROBE_SONG_ID = '3831661';

  for (let i = 0; i < valid.length; i++) {
    const desc = valid[i];
    try {
      const code = await desc.load();
      if (!code) {
        results.push(`#${i + 1} 加载失败`);
        allOk = false;
        continue;
      }
      scriptCache.set(desc.name, code);
      const ok = await initEnv(code, desc.name);
      if (!ok) {
        const err = lastInitError || '未知错误';
        results.push(`#${i + 1} 加载失败 (${err.substring(0, 40)})`);
        allOk = false;
        continue;
      }

      const srcs = supportedSources.length > 0 ? supportedSources.join(',') : '全部';

      // 真实探测一次 URL 解析能力
      const probeUrl = await requestMusicUrl(PROBE_SOURCE, PROBE_SONG_ID, '128k');
      if (probeUrl) {
        results.push(`#${i + 1} 正常 (${srcs})`);
      } else {
        // 脚本能加载，但取不到 URL —— 通常是后端服务挂了
        const backendUrls = extractBackendUrls(code);
        const hint = backendUrls.length > 0
          ? `后端可能不可用 (${backendUrls.join(', ')})`
          : '后端服务可能不可用（请检查音源脚本硬编码的 API 地址）';
        results.push(`#${i + 1} 能加载但取URL失败 (${hint})`);
        allOk = false;
      }
    } catch (e) {
      results.push(`#${i + 1} 异常: ${String(e).substring(0, 40)}`);
      allOk = false;
    }
  }

  return {
    ok: allOk,
    message: `${valid.length} 个音源: ${results.join('，')}`,
  };
}

/**
 * 按平台探测每个来源是否可用（像洛雪音源插件一样逐源检测）
 *
 * 对每个脚本声明支持的来源：先搜索一首真实歌曲拿到 songId，
 * 再通过脚本取 URL，据此判定该来源是否可用。
 * 脚本未声明的来源标记为 unsupported。
 *
 * @param sources 音源描述符列表
 * @returns 每个平台的检测状态
 */
export async function probePlatforms(
  sources: SourceDescriptor[]
): Promise<PlatformStatus[]> {
  const results: PlatformStatus[] = ALL_LX_SOURCES.map((s) => ({
    source: s,
    name: LX_SOURCE_NAMES[s],
    status: 'unreachable' as const,
  }));

  const set = (src: LXSource, status: PlatformStatus['status'], reason?: string) => {
    const r = results.find((x) => x.source === src);
    if (r) { r.status = status; r.reason = reason; }
  };

  const valid = sources.filter((s) => s && s.name);
  if (valid.length === 0) {
    return results;
  }

  // 加载首个脚本，建立环境并拿到 supportedSources
  const first = valid[0];
  const code = await first.load();
  if (!code) {
    for (const r of results) { r.status = 'unreachable'; r.reason = '脚本加载失败'; }
    return results;
  }
  scriptCache.set(first.name, code);
  const ok = await initEnv(code, first.name);
  if (!ok) {
    for (const r of results) { r.status = 'unreachable'; r.reason = '脚本初始化失败'; }
    return results;
  }

  const supported = supportedSources.length > 0 ? supportedSources : ALL_LX_SOURCES;

  // 用一首各平台都有的歌做探测（周杰伦 - 晴天）
  const PROBE_KEYWORD = '周杰伦 晴天';
  for (const src of ALL_LX_SOURCES) {
    if (!supported.includes(src)) {
      set(src, 'unsupported', '脚本未启用该来源');
      continue;
    }
    try {
      const found = await searchOnPlatform(PROBE_KEYWORD, src, 3);
      if (!found || found.length === 0) {
        set(src, 'fail', '搜索无结果');
        continue;
      }
      const id = found[0].songId;
      const url = await requestMusicUrl(src, id, '128k');
      if (url) {
        set(src, 'ok');
      } else {
        // 取不到 URL：多半是脚本后端不可用
        const backendUrls = extractBackendUrls(code);
        set(src, 'fail', backendUrls.length > 0
          ? `取URL失败（后端可能不可用: ${backendUrls.join(', ')}）`
          : '取URL失败（后端可能不可用）');
      }
    } catch (e) {
      set(src, 'fail', `探测异常: ${String(e).slice(0, 60)}`);
    }
  }

  return results;
}
