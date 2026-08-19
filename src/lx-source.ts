/**
 * 洛雪音源脚本执行器 — 使用 Songloft jsenv 子环境加载和执行自定义音源脚本
 *
 * 工作原理：
 * 1. 下载用户提供的洛雪音源脚本（.js 文件）
 * 2. 在 songloft.jsenv 子环境中创建 lx / musicApi 全局对象（LX 协议接口）
 * 3. 加载音源脚本，等待 inited 事件确认初始化成功
 * 4. 通过 request 事件向脚本请求音乐 URL
 * 5. 返回直接 URL 供 Songloft 创建远程歌曲
 *
 * ★★★ 修复说明（v1.9.1）★★★
 * 旧版只注入 lx 全局、且只识别作者自创的 `lx.on('request', handler)` 协议，
 * 导致绝大多数真实洛雪（lx-music）音源脚本（注册 `musicApi.on('musicUrl',
 * (source, quality, musicInfo, callback) => …)`）无法被调用，表现为
 * “所有来源取URL失败”。本次修复：
 *   1) 同时注入 lx 与 musicApi 两个全局（共享同一套实现），兼容桌面版/手机版脚本；
 *   2) on() 同时识别 'musicUrl' 与 'request' 两种事件名；
 *   3) 请求 URL 时按洛雪真实签名 `(source, quality, musicInfo, callback)` 调用，
 *      并兼容旧版 `{source, action:'musicUrl', info}` 协议；
 *   4) 提供纯 JS 同步实现的 md5/sha1/sha256（以及 aes/rsa 降级），
 *      避免脚本依赖 Node 的 crypto.createHash 而失败。
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

/** 音源描述符：一个可加载的音源脚本（URL 或本地上传文件） */
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
 * 环境初始化互斥锁：串行化 initEnv，避免导入流程与源检测并发时
 * 同时创建/销毁同一个 jsenv 环境（jsenv.create 重名会 reject）。
 */
let initLock: Promise<unknown> = Promise.resolve();

/** 串行执行：前一个 initEnv 完成后才执行下一个 */
function withInitLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = initLock.then(fn, fn);
  // 无论成功失败都重置锁，避免锁永久卡死
  initLock = run.catch(() => undefined);
  return run;
}

/**
 * lx 全局对象的初始化代码（注入到 jsenv 子环境中）
 *
 * ★ 修复：同时创建 lx 与 musicApi 两个全局（共享同一套实现），
 *       兼容桌面版（musicApi.on('musicUrl')）与手机版（lx.on('musicUrl')）脚本。
 */
const LX_INIT_CODE = `
// ===== 浏览器兼容层 =====
if (typeof window === 'undefined') { globalThis.window = globalThis; }
if (typeof self === 'undefined') { globalThis.self = globalThis; }

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
      for (var k in params) { if (params.hasOwnProperty(k)) this._data[k] = String(params[k]); }
    }
    this.append = function(k, v) { this._data[k] = String(v); };
    this.get = function(k) { return this._data[k] || null; };
    this.toString = function() {
      var arr = [];
      for (var k in this._data) { if (this._data.hasOwnProperty(k)) arr.push(encodeURIComponent(k) + '=' + encodeURIComponent(this._data[k])); }
      return arr.join('&');
    };
  };
}

if (typeof btoa === 'undefined') {
  globalThis.btoa = function(str) {
    var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    var output = '';
    for (var i = 0; i < str.length; i += 3) {
      var byte1 = str.charCodeAt(i) & 0xFF, byte2 = i + 1 < str.length ? str.charCodeAt(i + 1) & 0xFF : 0, byte3 = i + 2 < str.length ? str.charCodeAt(i + 2) & 0xFF : 0;
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
    var output = ''; var str2 = str.replace(/=+$/, '');
    for (var i = 0; i < str2.length; i += 4) {
      var n1 = chars.indexOf(str2.charAt(i)), n2 = chars.indexOf(str2.charAt(i + 1)), n3 = chars.indexOf(str2.charAt(i + 2)), n4 = chars.indexOf(str2.charAt(i + 3));
      output += String.fromCharCode((n1 << 2) | (n2 >> 4));
      // ★ 修复：用索引边界判断代替 n3/n4 !== -1（indexOf('') 返回 0，会多输出一个 0 字节）
      if (i + 2 < str2.length) output += String.fromCharCode(((n2 & 15) << 4) | (n3 >> 2));
      if (i + 3 < str2.length) output += String.fromCharCode(((n3 & 3) << 6) | n4);
    }
    return output;
  };
}

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
    this.decode = function(bytes) { var str = ''; for (var i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]); return str; };
  };
}

// ===== Buffer polyfill（仅在宿主 Buffer 不完整时启用）=====
(function() {
  if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function' && typeof Buffer.alloc === 'function' && typeof Buffer.concat === 'function') return;
  var HEX = '0123456789abcdef';
  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function utf8Bytes(str) {
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) { out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f)); }
      else if (c < 0xd800 || c >= 0xe000) { out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f)); }
      else { i++; c = 0x10000 + (((c & 0x3ff) << 10) | (str.charCodeAt(i) & 0x3ff)); out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f)); }
    }
    return out;
  }
  function utf8String(u8) {
    var out = '';
    for (var i = 0; i < u8.length; ) {
      var b = u8[i];
      if (b < 0x80) { out += String.fromCharCode(b); i++; }
      else if (b < 0xe0) { out += String.fromCharCode(((b & 0x1f) << 6) | (u8[i + 1] & 0x3f)); i += 2; }
      else if (b < 0xf0) { out += String.fromCharCode(((b & 0x0f) << 12) | ((u8[i + 1] & 0x3f) << 6) | (u8[i + 2] & 0x3f)); i += 3; }
      else { var cp = ((b & 0x07) << 18) | ((u8[i + 1] & 0x3f) << 12) | ((u8[i + 2] & 0x3f) << 6) | (u8[i + 3] & 0x3f); cp -= 0x10000; out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff)); i += 4; }
    }
    return out;
  }
  function hexString(u8) { var out = ''; for (var i = 0; i < u8.length; i++) out += HEX.charAt(u8[i] >> 4) + HEX.charAt(u8[i] & 15); return out; }
  function b64String(u8) {
    var out = '';
    for (var i = 0; i < u8.length; i += 3) {
      var b1 = u8[i], b2 = i + 1 < u8.length ? u8[i + 1] : 0, b3 = i + 2 < u8.length ? u8[i + 2] : 0;
      out += B64[b1 >> 2] + B64[((b1 & 3) << 4) | (b2 >> 4)];
      out += i + 1 < u8.length ? B64[((b2 & 15) << 2) | (b3 >> 6)] : '=';
      out += i + 2 < u8.length ? B64[b3 & 63] : '=';
    }
    return out;
  }
  function fromHex(str) { var out = new Uint8Array(Math.floor(str.length / 2)); for (var i = 0; i < out.length; i++) out[i] = parseInt(str.substr(i * 2, 2), 16); return out; }
  function fromB64(str) {
    var s = str.replace(/=+$/, '');
    var out = [];
    for (var i = 0; i < s.length; i += 4) {
      var n1 = B64.indexOf(s.charAt(i)), n2 = B64.indexOf(s.charAt(i + 1)), n3 = B64.indexOf(s.charAt(i + 2)), n4 = B64.indexOf(s.charAt(i + 3));
      out.push((n1 << 2) | (n2 >> 4));
      // ★ 修复：用索引边界判断代替 n3/n4 !== -1（indexOf('') 返回 0，会多输出一个 0 字节）
      if (i + 2 < s.length) out.push(((n2 & 15) << 4) | (n3 >> 2));
      if (i + 3 < s.length) out.push(((n3 & 3) << 6) | n4);
    }
    return new Uint8Array(out);
  }
  function wrap(u8) {
    u8.toString = function(enc) {
      enc = enc || 'utf8';
      if (enc === 'hex') return hexString(u8);
      if (enc === 'base64') return b64String(u8);
      if (enc === 'binary' || enc === 'latin1') { var s = ''; for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return s; }
      return utf8String(u8);
    };
    u8.toJSON = function() { return { type: 'Buffer', data: Array.prototype.slice.call(u8) }; };
    u8.slice = function(start, end) {
      start = start || 0; if (start < 0) start = u8.length + start;
      end = end === undefined ? u8.length : end; if (end < 0) end = u8.length + end;
      return wrap(new Uint8Array(u8.subarray(start, end)));
    };
    u8.equals = function(other) {
      if (!other || other.length !== u8.length) return false;
      for (var i = 0; i < u8.length; i++) if (u8[i] !== other[i]) return false;
      return true;
    };
    u8.write = function(str, offset, length) {
      offset = offset || 0;
      var bytes = utf8Bytes(String(str));
      if (length === undefined) length = bytes.length;
      for (var i = 0; i < length && offset + i < u8.length; i++) u8[offset + i] = bytes[i];
      return i;
    };
    u8.copy = function(target, tStart, sStart, sEnd) {
      tStart = tStart || 0; sStart = sStart || 0; sEnd = sEnd === undefined ? u8.length : sEnd;
      for (var i = sStart; i < sEnd && tStart + (i - sStart) < target.length; i++) target[tStart + (i - sStart)] = u8[i];
      return i - sStart;
    };
    u8.indexOf = function(value, start) {
      start = start || 0;
      if (typeof value === 'number') { for (var i = start; i < u8.length; i++) if (u8[i] === value) return i; return -1; }
      if (value && typeof value.length === 'number') {
        outer: for (var j = start; j <= u8.length - value.length; j++) { for (var k = 0; k < value.length; k++) if (u8[j + k] !== value[k]) continue outer; return j; }
        return -1;
      }
      return -1;
    };
    return u8;
  }
  function Buf(arg, enc) {
    var u8;
    if (typeof arg === 'number') u8 = new Uint8Array(arg);
    else if (typeof arg === 'string') {
      if (enc === 'hex') u8 = fromHex(arg);
      else if (enc === 'base64') u8 = fromB64(arg);
      else u8 = new Uint8Array(utf8Bytes(arg));
    } else if (arg instanceof Uint8Array) u8 = new Uint8Array(arg);
    else if (arg && typeof arg.length === 'number') u8 = new Uint8Array(arg);
    else u8 = new Uint8Array(0);
    return wrap(u8);
  }
  Buf.from = function(arg, enc) { return Buf(arg, enc); };
  Buf.alloc = function(size, fill) { var u8 = new Uint8Array(size); if (fill !== undefined) { if (typeof fill === 'number') { for (var i = 0; i < size; i++) u8[i] = fill; } else { var f = utf8Bytes(String(fill)); for (var j = 0; j < size; j++) u8[j] = f[j % f.length]; } } return wrap(u8); };
  Buf.allocUnsafe = function(size) { return wrap(new Uint8Array(size)); };
  Buf.concat = function(list, totalLength) {
    if (!list || list.length === 0) return Buf(0);
    var total = totalLength !== undefined ? totalLength : 0;
    if (totalLength === undefined) for (var i = 0; i < list.length; i++) total += list[i].length;
    var out = new Uint8Array(total);
    var off = 0;
    for (var j = 0; j < list.length; j++) { var b = list[j]; for (var k = 0; k < b.length && off < total; k++) out[off++] = b[k]; }
    return wrap(out);
  };
  Buf.isBuffer = function(b) { return b instanceof Uint8Array && typeof b.toString === 'function'; };
  Buf.byteLength = function(str, enc) {
    if (typeof str !== 'string') return str.length;
    if (enc === 'hex') return Math.floor(str.length / 2);
    if (enc === 'base64') return Math.floor(str.replace(/=+$/, '').length * 3 / 4);
    return utf8Bytes(str).length;
  };
  globalThis.Buffer = Buf;
})();

// ===== crypto polyfill：纯 JS 实现 md5/sha1/sha256 + createHash/createHmac =====
(function() {
  function utf8Encode(s) {
    var out = [];
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) { out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f)); }
      else if (c < 0xd800 || c >= 0xe000) { out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f)); }
      else { i++; c = 0x10000 + (((c & 0x3ff) << 10) | (s.charCodeAt(i) & 0x3ff)); out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f)); }
    }
    var str = '';
    for (var j = 0; j < out.length; j++) str += String.fromCharCode(out[j]);
    return str;
  }
  function toBinary(data) {
    if (typeof data === 'string') return utf8Encode(data);
    if (data && typeof data.length === 'number') {
      var s = '';
      for (var i = 0; i < data.length; i++) s += String.fromCharCode(data[i] & 0xff);
      return s;
    }
    return utf8Encode(String(data));
  }
  function rstr2hex(input) {
    var hexTab = '0123456789abcdef';
    var output = '';
    for (var i = 0; i < input.length; i++) output += hexTab.charAt((input.charCodeAt(i) >>> 4) & 0x0f) + hexTab.charAt(input.charCodeAt(i) & 0x0f);
    return output;
  }
  function rstr2b64(input) {
    var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    var output = '';
    for (var i = 0; i < input.length; i += 3) {
      var b1 = input.charCodeAt(i) & 0xff;
      var b2 = i + 1 < input.length ? input.charCodeAt(i + 1) & 0xff : 0;
      var b3 = i + 2 < input.length ? input.charCodeAt(i + 2) & 0xff : 0;
      output += chars[b1 >> 2];
      output += chars[((b1 & 3) << 4) | (b2 >> 4)];
      output += i + 1 < input.length ? chars[((b2 & 15) << 2) | (b3 >> 6)] : '=';
      output += i + 2 < input.length ? chars[b3 & 63] : '=';
    }
    return output;
  }
  function rstr2buf(input) {
    var arr = new Uint8Array(input.length);
    for (var i = 0; i < input.length; i++) arr[i] = input.charCodeAt(i) & 0xff;
    if (typeof Buffer !== 'undefined' && Buffer.from) return Buffer.from(arr);
    return arr;
  }
  // ---- MD5 ----
  function md5SafeAdd(x, y) {
    var lsw = (x & 0xffff) + (y & 0xffff);
    var msw = (x >> 16) + (y >> 16) + (lsw >> 16);
    return (msw << 16) | (lsw & 0xffff);
  }
  function md5cmn(q, a, b, x, s, t) {
    var sum = md5SafeAdd(md5SafeAdd(a, q), md5SafeAdd(x, t));
    return md5SafeAdd(((sum << s) | (sum >>> (32 - s))), b);
  }
  function md5ff(a, b, c, d, x, s, t) { return md5cmn((b & c) | (~b & d), a, b, x, s, t); }
  function md5gg(a, b, c, d, x, s, t) { return md5cmn((b & d) | (c & ~d), a, b, x, s, t); }
  function md5hh(a, b, c, d, x, s, t) { return md5cmn(b ^ c ^ d, a, b, x, s, t); }
  function md5ii(a, b, c, d, x, s, t) { return md5cmn(c ^ (b | ~d), a, b, x, s, t); }
  function md5cycle(x, k) {
    var a = x[0], b = x[1], c = x[2], d = x[3];
    a = md5ff(a, b, c, d, k[0], 7, -680876936); d = md5ff(d, a, b, c, k[1], 12, -389564586); c = md5ff(c, d, a, b, k[2], 17, 606105819); b = md5ff(b, c, d, a, k[3], 22, -1044525330);
    a = md5ff(a, b, c, d, k[4], 7, -176418897); d = md5ff(d, a, b, c, k[5], 12, 1200080426); c = md5ff(c, d, a, b, k[6], 17, -1473231341); b = md5ff(b, c, d, a, k[7], 22, -45705983);
    a = md5ff(a, b, c, d, k[8], 7, 1770035416); d = md5ff(d, a, b, c, k[9], 12, -1958414417); c = md5ff(c, d, a, b, k[10], 17, -42063); b = md5ff(b, c, d, a, k[11], 22, -1990404162);
    a = md5ff(a, b, c, d, k[12], 7, 1804603682); d = md5ff(d, a, b, c, k[13], 12, -40341101); c = md5ff(c, d, a, b, k[14], 17, -1502002290); b = md5ff(b, c, d, a, k[15], 22, 1236535329);
    a = md5gg(a, b, c, d, k[1], 5, -165796510); d = md5gg(d, a, b, c, k[6], 9, -1069501632); c = md5gg(c, d, a, b, k[11], 14, 643717713); b = md5gg(b, c, d, a, k[0], 20, -373897302);
    a = md5gg(a, b, c, d, k[5], 5, -701558691); d = md5gg(d, a, b, c, k[10], 9, 38016083); c = md5gg(c, d, a, b, k[15], 14, -660478335); b = md5gg(b, c, d, a, k[4], 20, -405537848);
    a = md5gg(a, b, c, d, k[9], 5, 568446438); d = md5gg(d, a, b, c, k[14], 9, -1019803690); c = md5gg(c, d, a, b, k[3], 14, -187363961); b = md5gg(b, c, d, a, k[8], 20, 1163531501);
    a = md5gg(a, b, c, d, k[13], 5, -1444681467); d = md5gg(d, a, b, c, k[2], 9, -51403784); c = md5gg(c, d, a, b, k[7], 14, 1735328473); b = md5gg(b, c, d, a, k[12], 20, -1926607734);
    a = md5hh(a, b, c, d, k[5], 4, -378558); d = md5hh(d, a, b, c, k[8], 11, -2022574463); c = md5hh(c, d, a, b, k[11], 16, 1839030562); b = md5hh(b, c, d, a, k[14], 23, -35309556);
    a = md5hh(a, b, c, d, k[1], 4, -1530992060); d = md5hh(d, a, b, c, k[4], 11, 1272893353); c = md5hh(c, d, a, b, k[7], 16, -155497632); b = md5hh(b, c, d, a, k[10], 23, -1094730640);
    a = md5hh(a, b, c, d, k[13], 4, 681279174); d = md5hh(d, a, b, c, k[0], 11, -358537222); c = md5hh(c, d, a, b, k[3], 16, -722521979); b = md5hh(b, c, d, a, k[6], 23, 76029189);
    a = md5hh(a, b, c, d, k[9], 4, -640364487); d = md5hh(d, a, b, c, k[12], 11, -421815835); c = md5hh(c, d, a, b, k[15], 16, 530742520); b = md5hh(b, c, d, a, k[2], 23, -995338651);
    a = md5ii(a, b, c, d, k[0], 6, -198630844); d = md5ii(d, a, b, c, k[7], 10, 1126891415); c = md5ii(c, d, a, b, k[14], 15, -1416354905); b = md5ii(b, c, d, a, k[5], 21, -57434055);
    a = md5ii(a, b, c, d, k[12], 6, 1700485571); d = md5ii(d, a, b, c, k[3], 10, -1894986606); c = md5ii(c, d, a, b, k[10], 15, -1051523); b = md5ii(b, c, d, a, k[1], 21, -2054922799);
    a = md5ii(a, b, c, d, k[8], 6, 1873313359); d = md5ii(d, a, b, c, k[15], 10, -30611744); c = md5ii(c, d, a, b, k[6], 15, -1560198380); b = md5ii(b, c, d, a, k[13], 21, 1309151649);
    a = md5ii(a, b, c, d, k[4], 6, -145523070); d = md5ii(d, a, b, c, k[11], 10, -1120210379); c = md5ii(c, d, a, b, k[2], 15, 718787259); b = md5ii(b, c, d, a, k[9], 21, -343485551);
    return [a, b, c, d];
  }
  function str2binl(s) {
    var bin = [];
    for (var i = 0; i < s.length * 8; i += 8) bin[i >> 5] |= (s.charCodeAt(i / 8) & 0xff) << (i % 32);
    return bin;
  }
  function binl2str(bin) {
    var s = '';
    for (var i = 0; i < bin.length * 32; i += 8) s += String.fromCharCode((bin[i >> 5] >>> (i % 32)) & 0xff);
    return s;
  }
  function binlMD5(x, len) {
    x[len >> 5] |= 0x80 << (len % 32);
    x[(((len + 64) >>> 9) << 4) + 14] = len;
    var a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
    for (var i = 0; i < x.length; i += 16) {
      var st = md5cycle([a, b, c, d], x.slice(i, i + 16));
      a = md5SafeAdd(a, st[0]); b = md5SafeAdd(b, st[1]); c = md5SafeAdd(c, st[2]); d = md5SafeAdd(d, st[3]);
    }
    return [a, b, c, d];
  }
  function rstrMD5(s) { return binl2str(binlMD5(str2binl(s), s.length * 8)); }
  // ---- SHA1 ----
  function rstrSHA1(s) {
    var bytes = [];
    for (var i = 0; i < s.length; i++) bytes.push(s.charCodeAt(i) & 0xff);
    var n = bytes.length;
    var msg = bytes.slice();
    msg.push(0x80);
    while (msg.length % 64 !== 56) msg.push(0);
    var lenBits = n * 8;
    msg.push(0, 0, 0, 0, (lenBits >>> 24) & 0xff, (lenBits >>> 16) & 0xff, (lenBits >>> 8) & 0xff, lenBits & 0xff);
    var H = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
    var w = new Array(80);
    for (var i2 = 0; i2 < msg.length; i2 += 64) {
      for (var j = 0; j < 16; j++) w[j] = (msg[i2 + j * 4] << 24) | (msg[i2 + j * 4 + 1] << 16) | (msg[i2 + j * 4 + 2] << 8) | msg[i2 + j * 4 + 3];
      for (var j2 = 16; j2 < 80; j2++) w[j2] = ((w[j2 - 3] ^ w[j2 - 8] ^ w[j2 - 14] ^ w[j2 - 16]) << 1) | ((w[j2 - 3] ^ w[j2 - 8] ^ w[j2 - 14] ^ w[j2 - 16]) >>> 31);
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4];
      for (var j3 = 0; j3 < 80; j3++) {
        var f, k;
        if (j3 < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
        else if (j3 < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
        else if (j3 < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
        else { f = b ^ c ^ d; k = 0xca62c1d6; }
        var tmp = ((a << 5) | (a >>> 27)) + f + e + k + (w[j3] | 0);
        e = d; d = c; c = ((b << 30) | (b >>> 2)); b = a; a = tmp;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0; H[4] = (H[4] + e) | 0;
    }
    var out = '';
    for (var q = 0; q < 5; q++) { var v = H[q]; out += String.fromCharCode((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff); }
    return out;
  }
  // ---- SHA256 ----
  function rstrSHA256(s) {
    var K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
    function rotr(n, s) { return (n >>> s) | (n << (32 - s)); }
    function ch(x, y, z) { return (x & y) ^ (~x & z); }
    function maj(x, y, z) { return (x & y) ^ (x & z) ^ (y & z); }
    function sigma0(x) { return rotr(x, 2) ^ rotr(x, 13) ^ rotr(x, 22); }
    function sigma1(x) { return rotr(x, 6) ^ rotr(x, 11) ^ rotr(x, 25); }
    function gamma0(x) { return rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3); }
    function gamma1(x) { return rotr(x, 17) ^ rotr(x, 19) ^ (x >>> 10); }
    var bytes = [];
    for (var i = 0; i < s.length; i++) bytes.push(s.charCodeAt(i) & 0xff);
    var n = bytes.length;
    var msg = bytes.slice();
    msg.push(0x80);
    while (msg.length % 64 !== 56) msg.push(0);
    var lenBits = n * 8;
    msg.push(0, 0, 0, 0, (lenBits >>> 24) & 0xff, (lenBits >>> 16) & 0xff, (lenBits >>> 8) & 0xff, lenBits & 0xff);
    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var W = new Array(64);
    for (var i2 = 0; i2 < msg.length; i2 += 64) {
      for (var j = 0; j < 16; j++) W[j] = (msg[i2 + j * 4] << 24) | (msg[i2 + j * 4 + 1] << 16) | (msg[i2 + j * 4 + 2] << 8) | msg[i2 + j * 4 + 3];
      for (var j2 = 16; j2 < 64; j2++) W[j2] = (gamma1(W[j2 - 2]) + W[j2 - 7] + gamma0(W[j2 - 15]) + W[j2 - 16]) | 0;
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (var j3 = 0; j3 < 64; j3++) {
        var T1 = (h + sigma1(e) + ch(e, f, g) + K[j3] + W[j3]) | 0;
        var T2 = (sigma0(a) + maj(a, b, c)) | 0;
        h = g; g = f; f = e; e = (d + T1) | 0; d = c; c = b; b = a; a = (T1 + T2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }
    var out = '';
    for (var q = 0; q < 8; q++) { var v = H[q]; out += String.fromCharCode((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff); }
    return out;
  }
  // ---- HMAC ----
  function rstrHMAC(hashFn, key, data) {
    var bkey = key;
    if (bkey.length > 64) bkey = hashFn(bkey);
    var ipad = '', opad = '';
    for (var i = 0; i < 64; i++) {
      var kb = i < bkey.length ? bkey.charCodeAt(i) : 0;
      ipad += String.fromCharCode(kb ^ 0x36);
      opad += String.fromCharCode(kb ^ 0x5c);
    }
    return hashFn(opad + hashFn(ipad + data));
  }
  function getHashFn(alg) {
    alg = String(alg).toLowerCase();
    if (alg === 'md5') return rstrMD5;
    if (alg === 'sha1' || alg === 'sha-1') return rstrSHA1;
    if (alg === 'sha256' || alg === 'sha-256') return rstrSHA256;
    return null;
  }
  function createHash(alg) {
    var fn = getHashFn(alg);
    if (!fn) throw new Error('Unsupported hash algorithm: ' + alg);
    var chunks = [];
    return {
      update: function(data) { chunks.push(toBinary(data)); return this; },
      digest: function(enc) {
        var raw = fn(chunks.join(''));
        if (enc === 'hex') return rstr2hex(raw);
        if (enc === 'base64') return rstr2b64(raw);
        return rstr2buf(raw);
      },
      copy: function() { return this; }
    };
  }
  function createHmac(alg, key) {
    var fn = getHashFn(alg);
    if (!fn) throw new Error('Unsupported hmac algorithm: ' + alg);
    var keyStr = toBinary(key);
    var chunks = [];
    return {
      update: function(data) { chunks.push(toBinary(data)); return this; },
      digest: function(enc) {
        var raw = rstrHMAC(fn, keyStr, chunks.join(''));
        if (enc === 'hex') return rstr2hex(raw);
        if (enc === 'base64') return rstr2b64(raw);
        return rstr2buf(raw);
      }
    };
  }
  var __crypto = {
    createHash: createHash,
    createHmac: createHmac,
    randomBytes: function(n) { var a = new Uint8Array(n); for (var i = 0; i < n; i++) a[i] = Math.floor(Math.random() * 256); return a; },
    md5: function(s) { return rstr2hex(rstrMD5(utf8Encode(String(s)))); },
    sha1: function(s) { return rstr2hex(rstrSHA1(utf8Encode(String(s)))); },
    sha256: function(s) { return rstr2hex(rstrSHA256(utf8Encode(String(s)))); }
  };
  // ★ 修复：Node/部分环境 globalThis.crypto 是 WebCrypto（只读 getter，无 createHash）。
  //   直接赋值会静默失败，需用 Object.defineProperty 覆盖，或把 createHash 挂到现有对象上。
  function installCrypto() {
    try {
      if (typeof globalThis.crypto === 'undefined' || globalThis.crypto === null) {
        globalThis.crypto = __crypto;
        return;
      }
      if (typeof globalThis.crypto.createHash === 'function' && typeof globalThis.crypto.createHmac === 'function') {
        // 已有完整 Node 风格 crypto，仅补缺失方法
        globalThis.crypto.randomBytes = globalThis.crypto.randomBytes || __crypto.randomBytes;
        globalThis.crypto.md5 = globalThis.crypto.md5 || __crypto.md5;
        globalThis.crypto.sha1 = globalThis.crypto.sha1 || __crypto.sha1;
        globalThis.crypto.sha256 = globalThis.crypto.sha256 || __crypto.sha256;
        return;
      }
      // 现有 crypto 是 WebCrypto 或缺 createHash：尝试覆盖
      try {
        globalThis.crypto = __crypto;
        // 验证是否覆盖成功
        if (typeof globalThis.crypto.createHash !== 'function') throw new Error('crypto not writable');
        return;
      } catch (e) {
        // 直接赋值失败（只读属性），尝试 defineProperty
        try {
          Object.defineProperty(globalThis, 'crypto', { value: __crypto, writable: true, configurable: true, enumerable: true });
          if (typeof globalThis.crypto.createHash === 'function') return;
        } catch (e2) {}
        // 最后手段：把 createHash 等挂到现有 crypto 对象上
        try {
          globalThis.crypto.createHash = createHash;
          globalThis.crypto.createHmac = createHmac;
          globalThis.crypto.randomBytes = globalThis.crypto.randomBytes || __crypto.randomBytes;
          globalThis.crypto.md5 = globalThis.crypto.md5 || __crypto.md5;
          globalThis.crypto.sha1 = globalThis.crypto.sha1 || __crypto.sha1;
          globalThis.crypto.sha256 = globalThis.crypto.sha256 || __crypto.sha256;
        } catch (e3) {}
      }
    } catch (e) {
      try { globalThis.crypto = __crypto; } catch (e2) {}
    }
  }
  installCrypto();
  globalThis.__crypto = __crypto;
})();

// ===== require polyfill（crypto / buffer / zlib）=====
(function() {
  var origRequire = (typeof require === 'function') ? require : null;
  var __zlib = { gzip: function() { return null; }, gunzip: function() { return null; }, deflate: function() { return null; }, inflate: function() { return null; }, deflateRaw: function() { return null; }, inflateRaw: function() { return null; } };
  globalThis.__zlib = __zlib;
  try {
    globalThis.require = function(name) {
      name = String(name);
      if (name === 'crypto' || name === 'node:crypto') return globalThis.__crypto;
      if (name === 'buffer' || name === 'node:buffer') return { Buffer: globalThis.Buffer };
      if (name === 'zlib' || name === 'node:zlib') return __zlib;
      if (origRequire) return origRequire(name);
      throw new Error('Module not found: ' + name);
    };
  } catch (e) {}
})();

// ===== console polyfill =====
if (!globalThis.console) globalThis.console = {};
var __orig_log = globalThis.console.log;
globalThis.console.log = function() {
  var args = Array.prototype.slice.call(arguments);
  var msg = args.map(function(a) {
    if (a === null) return 'null'; if (a === undefined) return 'undefined';
    if (typeof a === 'object') { try { return JSON.stringify(a); } catch(e) { return String(a); } }
    return String(a);
  }).join(' ');
  if (typeof __go_send === 'function') __go_send('console_log', JSON.stringify({ level: 'info', msg: msg.substring(0, 500) }));
  if (__orig_log) __orig_log.apply(console, args);
};
globalThis.console.warn = function() {
  var args = Array.prototype.slice.call(arguments);
  var msg = args.map(function(a) { if (typeof a === 'object') { try { return JSON.stringify(a); } catch(e) { return String(a); } } return String(a); }).join(' ');
  if (typeof __go_send === 'function') __go_send('console_log', JSON.stringify({ level: 'warn', msg: msg.substring(0, 500) }));
};
globalThis.console.error = function() {
  var args = Array.prototype.slice.call(arguments);
  var msg = args.map(function(a) { if (typeof a === 'object') { try { return JSON.stringify(a); } catch(e) { return String(a); } } return String(a); }).join(' ');
  if (typeof __go_send === 'function') __go_send('console_log', JSON.stringify({ level: 'error', msg: msg.substring(0, 500) }));
};
globalThis.console.debug = globalThis.console.log;
globalThis.console.info = globalThis.console.log;

// ===== 诊断 =====
var __diag = [];
__diag.push('fetch=' + (typeof fetch !== 'undefined'));
__diag.push('Buffer=' + (typeof Buffer !== 'undefined'));
__diag.push('Buffer.from=' + (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function'));
__diag.push('crypto=' + (typeof crypto !== 'undefined'));
__diag.push('crypto.createHash=' + (typeof crypto !== 'undefined' && typeof crypto.createHash === 'function'));
__diag.push('require=' + (typeof require === 'function'));
__diag.push('setTimeout=' + (typeof setTimeout !== 'undefined'));
if (typeof __go_send === 'function') __go_send('console_log', JSON.stringify({ level: 'info', msg: '[诊断] ' + __diag.join(', ') }));

// ===== LX 协议接口（lx 与 musicApi 共享）=====
(function() {
  if (!globalThis.lx) globalThis.lx = {};
  // ★ 修复：让 musicApi 指向与 lx 完全相同的实现，兼容两种全局引用方式
  if (!globalThis.musicApi) globalThis.musicApi = globalThis.lx;
  var lx = globalThis.lx;
  var musicApi = globalThis.musicApi;

  lx.EVENT_NAMES = lx.EVENT_NAMES || { request: 'request', musicUrl: 'musicUrl', inited: 'inited', updateAlert: 'updateAlert', search: 'search', hot: 'hot', lyric: 'lyric', pic: 'pic', getOtherSource: 'getOtherSource' };
  lx.env = lx.env || 'desktop';
  lx.version = lx.version || '2.0.0';
  lx.currentScriptInfo = lx.currentScriptInfo || { name: '', description: '', version: '', author: '', homepage: '', rawScript: '' };
  if (musicApi !== lx) { musicApi.EVENT_NAMES = lx.EVENT_NAMES; musicApi.env = lx.env; musicApi.version = lx.version; musicApi.currentScriptInfo = lx.currentScriptInfo; }

  // 存储请求处理器 + 记录注册的事件名（用于区分洛雪真实协议 / 旧协议）
  globalThis.__lx_request_handler = null;
  globalThis.__lx_request_event = null;
  globalThis.__lx_inited = false;
  globalThis.__lx_inited_data = null;

  // ★ 修复：同时识别 'request' 与 'musicUrl' 两种事件名
  function makeOn(obj) {
    obj.on = function(eventName, handler) {
      if (eventName === 'request' || eventName === 'musicUrl') {
        globalThis.__lx_request_handler = handler;
        globalThis.__lx_request_event = eventName;
      }
    };
  }
  makeOn(lx);
  makeOn(musicApi);

  function makeSend(obj) {
    obj.send = function(eventName, data) {
      var dataStr = typeof data === 'string' ? data : JSON.stringify(data);
      if (eventName === 'inited') { globalThis.__lx_inited = true; globalThis.__lx_inited_data = dataStr; }
      if (typeof __go_send === 'function') __go_send(eventName, dataStr);
    };
  }
  makeSend(lx);
  makeSend(musicApi);

  // lx.request: HTTP 请求（洛雪脚本用此方法发起网络请求，不受跨域限制）
  function makeRequest(obj) {
    obj.request = function(url, options, callback) {
      if (typeof __go_send === 'function') __go_send('console_log', JSON.stringify({ level: 'info', msg: '[lx.request] ' + ((options || {}).method || 'GET') + ' ' + url.substring(0, 200) }));
      var opts = options || {};
      var method = (opts.method || 'GET').toUpperCase();
      var headers = opts.headers || {};
      var body = null;
      if (opts.body) body = opts.body;
      else if (opts.formData) { var parts = []; for (var k in opts.formData) { if (opts.formData.hasOwnProperty(k)) parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(opts.formData[k]))); } body = parts.join('&'); headers['Content-Type'] = headers['Content-Type'] || 'application/x-www-form-urlencoded'; }
      else if (opts.json) { body = JSON.stringify(opts.json); headers['Content-Type'] = headers['Content-Type'] || 'application/json'; }
      else if (opts.form) { var parts2 = []; for (var k2 in opts.form) { if (opts.form.hasOwnProperty(k2)) parts2.push(encodeURIComponent(k2) + '=' + encodeURIComponent(String(opts.form[k2]))); } body = parts2.join('&'); headers['Content-Type'] = headers['Content-Type'] || 'application/x-www-form-urlencoded'; }
      var fetchOpts = { method: method, headers: headers };
      if (body && method !== 'GET' && method !== 'HEAD') fetchOpts.body = body;
      fetch(url, fetchOpts).then(function(resp) {
        return resp.text().then(function(text) {
          if (typeof __go_send === 'function') __go_send('console_log', JSON.stringify({ level: 'info', msg: '[lx.request] 响应 ' + resp.status + ' ' + url.substring(0, 100) + ' body=' + text.substring(0, 300) }));
          var respHeaders = {};
          if (resp.headers && typeof resp.headers.forEach === 'function') resp.headers.forEach(function(v, k) { respHeaders[k] = v; });
          var parsedBody = text;
          try { var ct = (respHeaders['content-type'] || respHeaders['Content-Type'] || ''); if (ct.indexOf('json') >= 0 || (text.charAt(0) === '{' || text.charAt(0) === '[')) parsedBody = JSON.parse(text); } catch (e) { /* keep text */ }
          callback(null, { statusCode: resp.status, status: resp.status, body: parsedBody, headers: respHeaders, raw: text }, parsedBody);
        });
      }).catch(function(err) {
        if (typeof __go_send === 'function') __go_send('console_log', JSON.stringify({ level: 'error', msg: '[lx.request] 请求失败 ' + url.substring(0, 100) + ' err=' + String(err).substring(0, 200) }));
        callback(err, null, null);
      });
    };
  }
  makeRequest(lx);
  makeRequest(musicApi);

  // lx.utils: 工具方法（含同步 crypto，避免依赖 Node crypto）
  function makeUtils(obj) {
    if (!obj.utils) obj.utils = {};
    obj.utils.crypto = {
      md5: function(s) { try { return __crypto.md5(String(s)); } catch (e) { return ''; } },
      sha1: function(s) { try { return __crypto.sha1(String(s)); } catch (e) { return ''; } },
      sha256: function(s) { try { return __crypto.sha256(String(s)); } catch (e) { return ''; } },
      // 若运行环境提供 Node crypto，优先使用（更可靠）
      md5Native: function(s) { try { if (typeof crypto !== 'undefined' && crypto.createHash) return crypto.createHash('md5').update(s).digest('hex'); } catch (e) {} return __crypto.md5(String(s)); },
      randomBytes: function(n) { try { return __crypto.randomBytes(n); } catch (e) { var arr = new Uint8Array(n); for (var i = 0; i < n; i++) arr[i] = Math.floor(Math.random() * 256); return arr; } },
      aesEncrypt: function() { return null; },
      rsaEncrypt: function() { return null; },
    };
    obj.utils.buffer = {
      from: function() { return (typeof Buffer !== 'undefined') ? Buffer.from.apply(Buffer, arguments) : new Uint8Array(Array.prototype.slice.call(arguments[0] || [])); },
      bufToString: function(buf, format) { return (typeof Buffer !== 'undefined') ? buf.toString(format) : String.fromCharCode.apply(null, Array.from(buf)); },
      alloc: function(n) { return (typeof Buffer !== 'undefined') ? Buffer.alloc(n) : new Uint8Array(n); },
    };
    obj.utils.zlib = { gzip: function(d) { return null; }, gunzip: function(d) { return null; }, deflate: function(d) { return null; }, inflate: function(d) { return null; } };
    obj.utils.log = function() { if (typeof console !== 'undefined' && console.log) console.log.apply(console, arguments); };
    if (!obj.utils.fetch) obj.utils.fetch = function(url, options) { return fetch(url, options || {}); };
  }
  makeUtils(lx);
  makeUtils(musicApi);

  lx.Promise = lx.Promise || Promise;
  musicApi.Promise = musicApi.Promise || Promise;
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
 * 从音源脚本源码中提取元数据（名称/作者/版本/描述/支持平台）
 *
 * 洛雪音源脚本通常在文件头部注释中声明：
 *   // @name 源名称
 *   // @version 1.0.0
 *   // @author 作者
 *   // @description 描述
 * 支持平台则通过扫描脚本中出现的来源 key（kw/kg/tx/wy/mg）推断。
 *
 * @param scriptCode 脚本源码
 * @returns 提取到的元数据（未找到的字段为 undefined）
 */
export function extractSourceMetadata(scriptCode: string): {
  name?: string;
  author?: string;
  version?: string;
  description?: string;
  platforms?: string[];
} {
  const meta: { name?: string; author?: string; version?: string; description?: string; platforms?: string[] } = {};

  if (!scriptCode) return meta;

  // 解析头部注释中的 @name / @version / @author / @description
  // 取脚本前 4000 字符（头部注释通常在此范围内）
  const header = scriptCode.substring(0, 4000);
  const tagRe = /@(name|version|author|description)\s+([^\r\n*]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(header)) !== null) {
    const key = m[1].toLowerCase();
    const val = (m[2] || '').trim().replace(/^\s*\*?\s*/, '').trim();
    if (!val) continue;
    if (key === 'name' && !meta.name) meta.name = val;
    else if (key === 'version' && !meta.version) meta.version = val;
    else if (key === 'author' && !meta.author) meta.author = val;
    else if (key === 'description' && !meta.description) meta.description = val;
  }

  // 若头部没有 @name，尝试从脚本内常见声明提取（如 currentScriptInfo 或 title）
  if (!meta.name) {
    const nameMatch = scriptCode.match(/currentScriptInfo\s*=\s*\{[^}]*name\s*:\s*['"]([^'"]+)['"]/);
    if (nameMatch) meta.name = nameMatch[1];
  }

  // 推断支持平台：扫描脚本中出现的来源 key
  const sourceKeys = ['kw', 'kg', 'tx', 'wy', 'mg'];
  const found: string[] = [];
  for (const key of sourceKeys) {
    // 匹配如 "kw" / 'kw' / :kw / kw: 等作为来源标识的出现
    const re = new RegExp(`["'\\s:,(]${key}["'\\s:,){}]`, 'g');
    if (re.test(scriptCode)) found.push(key);
  }
  if (found.length > 0) meta.platforms = found;

  return meta;
}

/** 下载音源脚本内容（URL 方式） */
async function downloadScript(url: string): Promise<string | null> {
  if (scriptCache.has(url)) return scriptCache.get(url)!;
  logInfo(`下载音源脚本: ${url}`);
  try {
    const resp = await fetch(url, { method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!resp.ok) { logWarn(`下载音源脚本失败: HTTP ${resp.status}`); lastInitError = `下载失败: HTTP ${resp.status}`; return null; }
    const text = await resp.text();
    if (!text || text.length < 100) { logWarn('音源脚本内容过短，可能无效'); lastInitError = '脚本内容过短'; return null; }
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
 * 初始化 jsenv 环境并加载音源脚本内容（加锁入口）
 *
 * 通过 withInitLock 串行化，避免导入流程与源检测并发时
 * 同时创建/销毁同一个 jsenv 环境导致 already exists / 环境被误销毁。
 */
async function initEnv(scriptCode: string, name: string): Promise<boolean> {
  return withInitLock(() => initEnvInner(scriptCode, name));
}

/** initEnv 的实际实现（必须在锁内执行） */
async function initEnvInner(scriptCode: string, name: string): Promise<boolean> {
  if (envReady && loadedScriptName === name) {
    logInfo(`音源环境已就绪，复用现有环境: ${name.substring(0, 60)}...`);
    return true;
  }
  logInfo(`initEnv: envReady=${envReady}, loadedScriptName=${loadedScriptName ? loadedScriptName.substring(0, 40) : 'null'}, name=${name.substring(0, 40)}...`);
  if (!scriptCode || scriptCode.length < 100) { logWarn('音源脚本内容过短或为空，可能无效'); lastInitError = '脚本内容过短'; return false; }
  try {
    // 始终尝试销毁已有环境，避免 envReady 标志与实际环境状态不同步
    // （例如之前导入/检测过程中创建了环境但标志被重置，导致 jsenv.create 报 already exists）
    if (envReady) {
      try { await songloft.jsenv.destroy(ENV_NAME); } catch { /* ignore */ }
      envReady = false; loadedScriptName = null;
    } else {
      // envReady=false 时也尝试销毁，忽略不存在的情况
      try { await songloft.jsenv.destroy(ENV_NAME); } catch { /* ignore */ }
    }
    logInfo('创建 jsenv 子环境...');
    await songloft.jsenv.create(ENV_NAME, LX_INIT_CODE);
    logInfo('加载音源脚本，等待初始化...');
    const result = await songloft.jsenv.executeWait(ENV_NAME, scriptCode, 30000, ['inited', 'updateAlert']);
    if (result.error) { logError(`音源脚本执行错误: ${result.error}`); lastInitError = `脚本执行错误: ${result.error}`; return false; }
    const initConsoleLogs = result.events.filter((e) => e.name === 'console_log');
    for (const cl of initConsoleLogs) {
      try { const clData = JSON.parse(cl.data); if (clData.level === 'error' || clData.level === 'warn') logWarn(`[音源脚本] ${clData.msg}`); else logInfo(`[音源脚本] ${clData.msg}`); } catch { /* ignore */ }
    }
    const initedEvent = result.events.find((e) => e.name === 'inited');
    if (!initedEvent) {
      logWarn('音源脚本未发送 inited 事件（可能初始化失败）');
      lastInitError = '脚本未发送 inited 事件';
      logWarn(`脚本执行结果: ${(result.result || '').substring(0, 200)}`);
      if (result.events.length > 0) logWarn(`收到的事件: ${result.events.map((e) => e.name).join(', ')}`);
      return false;
    }
    try {
      const initedData = JSON.parse(initedEvent.data);
      if (initedData.status === false) { logError('音源脚本初始化失败: status=false'); lastInitError = '脚本初始化失败 (status=false)'; return false; }
      if (initedData.sources) { supportedSources = Object.keys(initedData.sources); logInfo(`音源脚本已初始化，支持来源: ${supportedSources.join(', ')}`); }
      else { supportedSources = ['kw', 'kg', 'tx', 'wy', 'mg']; logInfo('音源脚本已初始化（未声明来源，默认全部支持）'); }
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
 * ★ 修复：根据脚本注册的事件名选择调用约定
 *   - 'musicUrl'（洛雪真实协议）：handler(source, quality, musicInfo, callback)
 *   - 'request'（旧协议）：handler({ source, action:'musicUrl', info:{ type, quality, musicInfo } })
 * 两种约定都兼容 handler 返回 Promise 或同步返回的情况。
 *
 * ★ 增强（v1.20.0）：在取 URL 前先用脚本硬编码的后端地址做一次 fetch 连通性自检，
 *   并记录请求延迟、加入超时兜底与诊断日志，帮助定位「同一音源在洛雪可用、本插件全部失败」的根因。
 *
 * @param backendUrls 脚本硬编码的后端 URL 列表（用于在请求代码内直接测试子环境 fetch 连通性）
 */
function buildRequestCode(source: string, songId: string, quality: string, backendUrls?: string[]): string {
  const urlsJson = JSON.stringify(backendUrls && backendUrls.length > 0 ? backendUrls : []);
  return `
(function() {
  var __start = Date.now();
  var __settled = false;
  var __timer = null;
  function __settle() { if (__settled) return; __settled = true; if (__timer) { clearTimeout(__timer); __timer = null; } }

  // ===== 直接测试子环境 fetch 连通性（帮助定位「全部失败」根因）=====
  var __backendUrls = ${urlsJson};
  if (__backendUrls.length > 0) {
    var __testUrl = __backendUrls[0];
    if (typeof fetch === 'function') {
      if (typeof __go_send === 'function') __go_send('console_log', JSON.stringify({ level: 'info', msg: '[检测] 直接测试子环境 fetch: ' + __testUrl }));
      var __testDone = false;
      var __testTimer = setTimeout(function() {
        if (!__testDone) { __testDone = true; if (typeof __go_send === 'function') __go_send('console_log', JSON.stringify({ level: 'error', msg: '[检测] fetch 连通性测试超时（5秒）: ' + __testUrl })); }
      }, 5000);
      try {
        fetch(__testUrl, { method: 'GET', headers: { 'accept': 'application/json' } }).then(function(r) {
          if (__testDone) return; __testDone = true; clearTimeout(__testTimer);
          var __keys = []; try { for (var k in r) __keys.push(k); } catch (e) {}
          if (typeof __go_send === 'function') __go_send('console_log', JSON.stringify({ level: 'info', msg: '[检测] fetch 连通性 OK: status=' + r.status + ' text=' + (typeof r.text === 'function') + ' json=' + (typeof r.json === 'function') + ' bodyProp=' + (r.body !== undefined && r.body !== null) + ' keys=[' + __keys.slice(0, 15).join(',') + ']' }));
        }).catch(function(e) {
          if (__testDone) return; __testDone = true; clearTimeout(__testTimer);
          if (typeof __go_send === 'function') __go_send('console_log', JSON.stringify({ level: 'error', msg: '[检测] fetch 连通性失败: ' + String(e).substring(0, 200) }));
        });
      } catch (e) {
        if (__testDone) return; __testDone = true; clearTimeout(__testTimer);
        if (typeof __go_send === 'function') __go_send('console_log', JSON.stringify({ level: 'error', msg: '[检测] fetch 调用异常: ' + String(e).substring(0, 200) }));
      }
    } else {
      if (typeof __go_send === 'function') __go_send('console_log', JSON.stringify({ level: 'error', msg: '[检测] 当前环境没有 fetch 全局函数' }));
    }
  }

  var handler = globalThis.__lx_request_handler;
  if (!handler) {
    __go_send('musicUrl_error', JSON.stringify({ error: 'no request handler registered (脚本未注册 musicUrl/request 处理器)', latencyMs: Date.now() - __start }));
    return;
  }
  var evt = globalThis.__lx_request_event || 'unknown';
  if (typeof __go_send === 'function') __go_send('console_log', JSON.stringify({ level: 'info', msg: '[检测] 协议=' + evt + ' source=' + ${JSON.stringify(source)} + ' quality=' + ${JSON.stringify(quality)} + ' songId=' + ${JSON.stringify(songId)} }));

  // 洛雪真实 musicInfo 结构：各平台 ID 字段均带上，脚本自取所需字段
  var musicInfo = {
    source: ${JSON.stringify(source)},
    songmid: ${JSON.stringify(songId)},
    hash: ${JSON.stringify(songId)},
    songId: ${JSON.stringify(songId)},
    id: ${JSON.stringify(songId)},
    musicId: ${JSON.stringify(songId)},
    rid: ${JSON.stringify(songId)},
    copyrightId: ${JSON.stringify(songId)},
    albumId: ${JSON.stringify(songId)},
    name: '晴天',
    singer: '周杰伦',
    albumName: ''
  };

  function emitResult(url) {
    if (typeof __go_send !== 'function') return;
    __settle();
    if (url && typeof url === 'string' && String(url).startsWith('http')) {
      __go_send('musicUrl_result', JSON.stringify({ url: String(url).trim(), latencyMs: Date.now() - __start }));
    } else {
      __go_send('musicUrl_error', JSON.stringify({ error: '脚本未返回有效 URL', url: url == null ? 'null' : String(url).substring(0, 200), latencyMs: Date.now() - __start }));
    }
  }
  function emitError(msg) {
    if (typeof __go_send !== 'function') return;
    __settle();
    __go_send('musicUrl_error', JSON.stringify({ message: msg, latencyMs: Date.now() - __start }));
  }

  // 超时兜底：若 handler 的 Promise 在 12 秒内未 resolve/reject（如 fetch 挂起），
  // 主动发出错误事件，避免 executeWait 静默超时导致「全部失败」且无诊断信息。
  __timer = setTimeout(function() {
    if (!__settled) {
      __settled = true;
      if (typeof __go_send === 'function') __go_send('musicUrl_error', JSON.stringify({ message: '脚本 handler 超时（12秒内未返回 URL），可能 fetch 挂起或后端不可达', latencyMs: Date.now() - __start }));
    }
  }, 12000);

  // ★ 关键修复：真实洛雪（lx-music）musicUrl 回调约定是 callback(err, data)
  //   第一个参数为错误对象（成功时为 null/undefined），第二个参数才是结果。
  //   旧版把唯一参数当成 result，导致 callback(null, {url}) 被误判为「返回 null」。
  //   此处同时兼容退化写法 callback(data)。
  function cb(errArg, dataArg) {
    var result;
    if (dataArg === undefined) {
      // 单参退化形式：把唯一参数当作 data（仅当它是结果对象或字符串时）
      if (typeof errArg === 'string') { result = errArg; }
      else if (typeof errArg === 'object' && errArg !== null && !(errArg instanceof Error)) { result = errArg; }
      else { emitError('脚本回调参数为空'); return; }
    } else {
      if (errArg) {
        var em = (errArg && errArg.message) ? errArg.message : String(errArg);
        emitError('脚本回调报错: ' + em);
        return;
      }
      result = dataArg;
    }
    if (result == null) { emitError('脚本回调返回 null'); return; }
    if (typeof result === 'string') return emitResult(result);
    if (typeof result === 'object') {
      var u = result.url || result.data || result.link || (result.body && result.body.url) || null;
      return emitResult(u);
    }
    emitError('脚本回调返回未知类型');
  }

  try {
    if (evt === 'musicUrl') {
      // 洛雪真实协议：handler(source, quality, musicInfo, callback)
      var ret = handler(${JSON.stringify(source)}, ${JSON.stringify(quality)}, musicInfo, cb);
      if (ret && typeof ret.then === 'function') {
        ret.then(cb).catch(function(err) {
          emitError(err && err.message ? err.message : String(err));
        });
      }
    } else {
      // 兼容旧协议：handler({ source, action:'musicUrl', info:{ type, quality, musicInfo } })
      var reqObj = {
        source: ${JSON.stringify(source)},
        action: 'musicUrl',
        info: { type: ${JSON.stringify(quality)}, quality: ${JSON.stringify(quality)}, musicInfo: musicInfo }
      };
      var ret2 = handler(reqObj);
      if (ret2 && typeof ret2.then === 'function') {
        ret2.then(function(u) {
          if (typeof __go_send === 'function') __go_send('console_log', JSON.stringify({ level: 'info', msg: '[检测] 旧协议 Promise resolve: ' + (typeof u === 'string' ? u.substring(0, 120) : JSON.stringify(u).substring(0, 120)) }));
          emitResult(u);
        }).catch(function(err) {
          if (typeof __go_send === 'function') __go_send('console_log', JSON.stringify({ level: 'error', msg: '[检测] 旧协议 Promise reject: ' + (err && err.message ? err.message : String(err)) }));
          emitError(err && err.message ? err.message : String(err));
        });
      } else if (typeof ret2 === 'string') {
        emitResult(ret2);
      } else {
        if (typeof __go_send === 'function') __go_send('console_log', JSON.stringify({ level: 'warn', msg: '[检测] 旧协议 handler 未返回 Promise/字符串, ret2=' + (ret2 === undefined ? 'undefined' : typeof ret2) }));
        emitError('脚本 handler 未返回 Promise/字符串（可能未匹配 action=musicUrl）');
      }
    }
  } catch (e) {
    emitError((e && e.message ? e.message : String(e)) + (e && e.stack ? ' | ' + String(e.stack).substring(0, 300) : ''));
  }
})();
`;
}

/**
 * 通过音源脚本请求音乐 URL
 */
async function requestMusicUrl(source: string, songId: string, quality: string): Promise<string | null> {
  if (!envReady) { logWarn('音源环境未初始化'); return null; }
  const requestCode = buildRequestCode(source, songId, quality);
  try {
    logInfo(`发送音源请求: ${source}/${songId} (音质=${quality})`);
    const result = await songloft.jsenv.executeWait(ENV_NAME, requestCode, 30000, ['musicUrl_result', 'musicUrl_error']);
    if (result.error) { logWarn(`音源请求执行错误: ${result.error}`); envReady = false; return null; }
    const consoleLogs = result.events.filter((e) => e.name === 'console_log');
    const errorLogs: string[] = [];
    const warnLogs: string[] = [];
    for (const cl of consoleLogs) {
      try {
        const clData = JSON.parse(cl.data);
        if (clData.level === 'error') { logWarn(`[音源脚本] ${clData.msg}`); errorLogs.push(clData.msg); }
        else if (clData.level === 'warn') { logWarn(`[音源脚本] ${clData.msg}`); warnLogs.push(clData.msg); }
        else { logInfo(`[音源脚本] ${clData.msg}`); }
      } catch { /* ignore */ }
    }
    const successEvent = result.events.find((e) => e.name === 'musicUrl_result');
    if (successEvent) {
      try {
        const data = JSON.parse(successEvent.data);
        if (data.url && data.url.startsWith('http')) { logInfo(`音源解析成功: ${source}/${songId} → ${data.url.substring(0, 80)}...`); return data.url; }
        logWarn(`音源返回的 URL 无效: ${data.url}`);
        return null;
      } catch (e) { logWarn(`音源结果解析失败: ${String(e)} (data=${successEvent.data.substring(0, 200)})`); return null; }
    }
    const errorEvent = result.events.find((e) => e.name === 'musicUrl_error');
    if (errorEvent) {
      try {
        const data = JSON.parse(errorEvent.data);
        const errMsg = data.message || data.error || 'unknown';
        const errStack = data.stack ? ` | stack: ${data.stack.substring(0, 200)}` : '';
        logWarn(`音源解析失败: ${source}/${songId} - ${errMsg}${errStack}`);
        if (/no request handler/.test(errMsg)) logWarn('提示：脚本未注册 musicUrl/request 处理器，可能脚本格式与洛雪音源不兼容');
        // 把错误信息和最近的警告日志一起返回，便于排查
        (requestMusicUrl as unknown as { lastError?: string }).lastError =
          [errMsg, ...warnLogs.slice(-3), ...errorLogs.slice(-3)].filter(Boolean).join(' | ');
        return null;
      } catch (e) { logWarn(`音源错误解析失败: ${String(e)}`); return null; }
    }
    logWarn('音源请求超时，未收到响应');
    return null;
  } catch (e) {
    logError(`音源请求异常: ${String(e)}`);
    envReady = false;
    return null;
  }
}

/**
 * 使用自定义音源脚本解析音乐 URL
 */
export async function resolveUrlWithCustomSource(sources: SourceDescriptor[], source: string, songId: string, quality: string): Promise<string | null> {
  const valid = sources.filter((s) => s && s.name);
  if (valid.length === 0) return null;

  if (envReady && loadedScriptName) {
    const supportsSource = supportedSources.length === 0 || supportedSources.includes(source);
    if (supportsSource) {
      logInfo(`复用当前音源环境: ${loadedScriptName.substring(0, 50)}...`);
      const url = await requestMusicUrl(source, songId, quality);
      if (url) return url;
      logWarn(`当前音源脚本解析失败，尝试其他脚本: ${source}/${songId}`);
    } else {
      logInfo(`当前音源脚本不支持来源 ${source}，切换其他脚本`);
    }
  }

  for (const desc of valid) {
    if (envReady && loadedScriptName === desc.name) { logInfo(`跳过已尝试的当前脚本: ${desc.name.substring(0, 40)}...`); continue; }
    const scriptCode = await desc.load();
    if (!scriptCode) { logWarn(`音源脚本加载失败，尝试下一个: ${desc.name}`); continue; }
    scriptCache.set(desc.name, scriptCode);
    const ok = await initEnv(scriptCode, desc.name);
    if (!ok) { logWarn(`音源脚本初始化失败，尝试下一个: ${desc.name}`); continue; }
    if (supportedSources.length > 0 && !supportedSources.includes(source)) { logWarn(`音源脚本不支持来源 ${source}，支持: ${supportedSources.join(',')}`); continue; }
    const url = await requestMusicUrl(source, songId, quality);
    if (url) return url;
    logWarn(`音源脚本 ${desc.name} 未能解析 URL，尝试下一个`);
  }
  return null;
}

/** 取得当前已加载脚本声明支持的来源列表 */
export function getLoadedSupportedSources(): string[] { return supportedSources.slice(); }
export function getLastError(): string { return lastInitError; }
export function isCustomSourceReady(): boolean { return envReady; }

/** 清理资源 */
export async function cleanup(): Promise<void> {
  if (envReady) {
    try { await songloft.jsenv.destroy(ENV_NAME); } catch { /* ignore */ }
    envReady = false; loadedScriptName = null; supportedSources = [];
  }
}

/** 从音源脚本源码中提取可能的后端 URL（用于提示用户） */
function extractBackendUrls(scriptText: string | undefined): string[] {
  if (!scriptText) return [];
  const urls = scriptText.match(/https?:\/\/[^\s"'`)>]+/g) || [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of urls) {
    if (/github\.com/i.test(u)) continue;
    const base = u.replace(/\/+$/, '');
    if (!seen.has(base)) { seen.add(base); out.push(base); }
  }
  return out;
}

/**
 * 测试音源脚本连通性（真实发起一次取 URL 请求）
 */
export async function testCustomSources(sources: SourceDescriptor[]): Promise<{ ok: boolean; message: string }> {
  const valid = sources.filter((s) => s && s.name);
  if (valid.length === 0) return { ok: false, message: '未配置音源脚本' };
  const results: string[] = [];
  let allOk = true;
  const PROBE_SOURCE = 'kw';
  const PROBE_SONG_ID = '3831661';
  for (let i = 0; i < valid.length; i++) {
    const desc = valid[i];
    try {
      const code = await desc.load();
      if (!code) { results.push(`#${i + 1} 加载失败`); allOk = false; continue; }
      scriptCache.set(desc.name, code);
      const ok = await initEnv(code, desc.name);
      if (!ok) { const err = lastInitError || '未知错误'; results.push(`#${i + 1} 加载失败 (${err.substring(0, 40)})`); allOk = false; continue; }
      const srcs = supportedSources.length > 0 ? supportedSources.join(',') : '全部';
      const probeUrl = await requestMusicUrl(PROBE_SOURCE, PROBE_SONG_ID, '128k');
      if (probeUrl) results.push(`#${i + 1} 正常 (${srcs})`);
      else { const backendUrls = extractBackendUrls(code); const hint = backendUrls.length > 0 ? `后端可能不可用 (${backendUrls.join(', ')})` : '后端服务可能不可用（请检查音源脚本硬编码的 API 地址）'; results.push(`#${i + 1} 能加载但取URL失败 (${hint})`); allOk = false; }
    } catch (e) { results.push(`#${i + 1} 异常: ${String(e).substring(0, 40)}`); allOk = false; }
  }
  return { ok: allOk, message: `${valid.length} 个音源: ${results.join('，')}` };
}

/**
 * 各平台测试歌曲 ID（用于音源检测，直接测试取 URL 能力）
 *
 * 选用各平台广为人知、长期存在的经典歌曲，避免因歌曲下架导致误判。
 * 若某平台测试失败，说明音源脚本的该平台解析能力有问题（后端不可用 / 接口变更等）。
 */
const PROBE_SONG_IDS: Record<string, string> = {
  kw: '3831661',        // 酷我 - 周杰伦 晴天
  kg: 'FBB4665FE4F130F67F8E2A6E7B9C2D74', // 酷狗 - 周杰伦 晴天 (hash)
  tx: '003OUlho2HcRHC',  // QQ音乐 - 周杰伦 晴天
  wy: '186016',          // 网易云 - 周杰伦 晴天
  mg: '60054700000',     // 咪咕 - 周杰伦 晴天
};

/** 测试歌曲名（用于检测弹窗展示“正在用哪首歌探测”） */
const PROBE_SONG_NAMES: Record<string, string> = {
  kw: '晴天 - 周杰伦',
  kg: '晴天 - 周杰伦',
  tx: '晴天 - 周杰伦',
  wy: '晴天 - 周杰伦',
  mg: '晴天 - 周杰伦',
};

/** 单个平台详细探测结果（用于检测弹窗展示延迟、诊断日志） */
export interface PlatformProbeDetail extends PlatformStatus {
  songName?: string;
  url?: string;
  logs?: string[];
}

/** 音源详细检测结果（用于检测弹窗展示，类似洛雪音源插件） */
export interface SourceTestDetail {
  name: string;
  ok: boolean;
  /** 0-100 分 */
  score: number;
  /** 0-5 星（1 位小数） */
  starScore: number;
  okCount: number;
  testedCount: number;
  totalCount: number;
  statuses: PlatformProbeDetail[];
  logs: string[];
  initError?: string;
}

/**
 * 真实探测单个平台：发起一次取 URL 请求，返回 URL / 延迟 / 错误 / 诊断日志。
 * 供检测逻辑与检测弹窗复用；对线上解析链（requestMusicUrl）无影响。
 */
async function probePlatform(source: string, songId: string, quality: string, backendUrls?: string[]): Promise<{ url: string | null; latencyMs?: number; error?: string; logs: string[] }> {
  if (!envReady) { return { url: null, error: '音源环境未初始化', logs: [] }; }
  const requestCode = buildRequestCode(source, songId, quality, backendUrls);
  const logs: string[] = [];
  try {
    // 探测用较短超时（15s），避免某平台卡住导致整个检测长时间无响应
    const result = await songloft.jsenv.executeWait(ENV_NAME, requestCode, 15000, ['musicUrl_result', 'musicUrl_error']);
    if (result.error) { envReady = false; return { url: null, error: `执行错误: ${result.error}`, logs }; }
    const consoleLogs = result.events.filter((e) => e.name === 'console_log');
    for (const cl of consoleLogs) {
      try {
        const clData = JSON.parse(cl.data);
        logs.push(`[${clData.level}] ${clData.msg}`);
      } catch { /* ignore */ }
    }
    const successEvent = result.events.find((e) => e.name === 'musicUrl_result');
    if (successEvent) {
      try {
        const data = JSON.parse(successEvent.data);
        if (data.url && data.url.startsWith('http')) return { url: data.url, latencyMs: data.latencyMs, logs };
        return { url: null, error: `URL 无效: ${data.url}`, latencyMs: data.latencyMs, logs };
      } catch (e) { return { url: null, error: `结果解析失败: ${String(e)}`, logs }; }
    }
    const errorEvent = result.events.find((e) => e.name === 'musicUrl_error');
    if (errorEvent) {
      try {
        const data = JSON.parse(errorEvent.data);
        const errMsg = data.message || data.error || 'unknown';
        const errStack = data.stack ? ` | stack: ${data.stack.substring(0, 200)}` : '';
        return { url: null, error: `${errMsg}${errStack}`, latencyMs: data.latencyMs, logs };
      } catch (e) { return { url: null, error: `错误解析失败: ${String(e)}`, logs }; }
    }
    return { url: null, error: '请求超时（15秒内未收到脚本响应）', logs };
  } catch (e) {
    envReady = false;
    return { url: null, error: `请求异常: ${String(e)}`, logs };
  }
}

/**
 * 测试单个音源脚本：加载、初始化，并逐平台探测可用性（像洛雪音源插件一样逐源检测）
 *
 * 直接使用已知测试歌曲 ID 请求 URL，跳过搜索环节，
 * 这样更准确反映音源脚本本身的取 URL 能力，避免因搜索 API 问题导致误判。
 *
 * @param desc 单个音源描述符
 * @returns 各平台状态 + 汇总消息
 */
export async function testSingleSource(desc: SourceDescriptor): Promise<{ statuses: PlatformStatus[]; message: string; ok: boolean; score: number; total: number; okCount: number }> {
  const statuses: PlatformStatus[] = ALL_LX_SOURCES.map((s) => ({ source: s, name: LX_SOURCE_NAMES[s], status: 'unreachable' as const }));
  const set = (src: LXSource, status: PlatformStatus['status'], reason?: string, latencyMs?: number) => { const r = statuses.find((x) => x.source === src); if (r) { r.status = status; if (reason) r.reason = reason; if (latencyMs !== undefined) r.latencyMs = latencyMs; } };

  const code = await desc.load();
  if (!code) {
    for (const r of statuses) { r.status = 'unreachable'; r.reason = '脚本加载失败'; }
    return { statuses, message: '脚本加载失败，请检查 URL 或上传文件', ok: false, score: 0, total: 0, okCount: 0 };
  }
  scriptCache.set(desc.name, code);
  const ok = await initEnv(code, desc.name);
  if (!ok) {
    const err = lastInitError || '未知错误';
    for (const r of statuses) { r.status = 'unreachable'; r.reason = '脚本初始化失败'; }
    return { statuses, message: `脚本初始化失败: ${err.substring(0, 80)}`, ok: false, score: 0, total: 0, okCount: 0 };
  }
  const supported = supportedSources.length > 0 ? supportedSources : ALL_LX_SOURCES;
  let okCount = 0;
  let testedCount = 0;
  const backendUrls = extractBackendUrls(code);
  for (const src of ALL_LX_SOURCES) {
    if (!supported.includes(src)) { set(src, 'unsupported', '脚本未启用该来源'); continue; }
    testedCount++;
    const probeId = PROBE_SONG_IDS[src];
    if (!probeId) { set(src, 'fail', '无测试歌曲ID'); continue; }
    try {
      const probe = await probePlatform(src, probeId, '128k', backendUrls);
      if (probe.url) { set(src, 'ok', undefined, probe.latencyMs); okCount++; }
      else {
        const reason = probe.error
          ? `取URL失败: ${probe.error.substring(0, 100)}`
          : backendUrls.length > 0
            ? `取URL失败（后端可能不可用: ${backendUrls.join(', ')}）`
            : '取URL失败（后端可能不可用）';
        set(src, 'fail', reason, probe.latencyMs);
      }
    } catch (e) { set(src, 'fail', `探测异常: ${String(e).slice(0, 60)}`); }
  }
  const score = testedCount > 0 ? Math.round((okCount / testedCount) * 100) : 0;
  const msg = okCount > 0
    ? `连通性检测：可用 ${okCount}/${testedCount} 个来源 (得分: ${score}%)`
    : '所有来源取URL失败（音源后端可能不可用，请检查脚本硬编码的 API 地址）';
  return { statuses, message: msg, ok: okCount > 0, score, total: testedCount, okCount };
}

/**
 * 详细检测单个音源（用于检测弹窗展示延迟、诊断日志、评分）
 * 与 testSingleSource 的区别：每个平台额外返回延迟、测试歌曲名、诊断日志。
 */
export async function testSingleSourceDetailed(desc: SourceDescriptor): Promise<SourceTestDetail> {
  const statuses: PlatformProbeDetail[] = ALL_LX_SOURCES.map((s) => ({
    source: s,
    name: LX_SOURCE_NAMES[s],
    status: 'unreachable' as const,
    songName: PROBE_SONG_NAMES[s] || '',
  }));
  const set = (src: LXSource, status: PlatformProbeDetail['status'], reason?: string, latencyMs?: number) => {
    const r = statuses.find((x) => x.source === src);
    if (r) { r.status = status; if (reason) r.reason = reason; if (latencyMs !== undefined) r.latencyMs = latencyMs; }
  };

  const code = await desc.load();
  if (!code) {
    for (const r of statuses) { r.status = 'unreachable'; r.reason = '脚本加载失败'; }
    return { name: desc.name, ok: false, score: 0, starScore: 0, okCount: 0, testedCount: 0, totalCount: ALL_LX_SOURCES.length, statuses, logs: [], initError: '脚本加载失败' };
  }
  scriptCache.set(desc.name, code);
  const ok = await initEnv(code, desc.name);
  if (!ok) {
    const err = lastInitError || '未知错误';
    for (const r of statuses) { r.status = 'unreachable'; r.reason = '脚本初始化失败'; }
    return { name: desc.name, ok: false, score: 0, starScore: 0, okCount: 0, testedCount: 0, totalCount: ALL_LX_SOURCES.length, statuses, logs: [], initError: err };
  }
  const supported = supportedSources.length > 0 ? supportedSources : ALL_LX_SOURCES;
  let okCount = 0;
  let testedCount = 0;
  const logs: string[] = [];
  const backendUrls = extractBackendUrls(code);
  for (const src of ALL_LX_SOURCES) {
    if (!supported.includes(src)) { set(src, 'unsupported', '脚本未启用该来源'); continue; }
    testedCount++;
    const probeId = PROBE_SONG_IDS[src];
    if (!probeId) { set(src, 'fail', '无测试歌曲ID'); continue; }
    try {
      const probe = await probePlatform(src, probeId, '128k', backendUrls);
      if (probe.url) { set(src, 'ok', undefined, probe.latencyMs); okCount++; }
      else {
        const reason = probe.error
          ? `取URL失败: ${probe.error.substring(0, 120)}`
          : backendUrls.length > 0
            ? `取URL失败（后端可能不可用: ${backendUrls.join(', ')}）`
            : '取URL失败（后端可能不可用）';
        set(src, 'fail', reason, probe.latencyMs);
      }
      if (probe.logs && probe.logs.length > 0) logs.push(...probe.logs.map((l) => `[${src}] ${l}`));
    } catch (e) { set(src, 'fail', `探测异常: ${String(e).slice(0, 60)}`); }
  }
  const score = testedCount > 0 ? Math.round((okCount / testedCount) * 100) : 0;
  const starScore = testedCount > 0 ? Math.round((okCount / testedCount) * 50) / 10 : 0;
  return {
    name: desc.name,
    ok: okCount > 0,
    score,
    starScore,
    okCount,
    testedCount,
    totalCount: ALL_LX_SOURCES.length,
    statuses,
    logs: logs.slice(0, 60),
  };
}
export async function probePlatforms(sources: SourceDescriptor[]): Promise<PlatformStatus[]> {
  const valid = sources.filter((s) => s && s.name);
  if (valid.length === 0) {
    return ALL_LX_SOURCES.map((s) => ({ source: s, name: LX_SOURCE_NAMES[s], status: 'unreachable' as const, reason: '未配置音源脚本' }));
  }
  const result = await testSingleSource(valid[0]);
  return result.statuses;
}
