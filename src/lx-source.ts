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
 * 纯 JS 同步 crypto 实现（md5 / sha1 / sha256）
 * 避免脚本依赖 Node.js 的 crypto.createHash（jsenv 中通常不存在）。
 */
const SYNC_CRYPTO = (function () {
  // ---------------- md5 ----------------
  function md5(s: string): string {
    function add32(a: number, b: number) { return (a + b) & 0xffffffff; }
    function cmn(q: number, a: number, b: number, x: number, s: number, t: number) {
      a = add32(add32(a, q), add32(x, t));
      return add32((a << s) | (a >>> (32 - s)), b);
    }
    function ff(a: number, b: number, c: number, d: number, x: number, s: number, t: number) { return cmn((b & c) | (~b & d), a, b, x, s, t); }
    function gg(a: number, b: number, c: number, d: number, x: number, s: number, t: number) { return cmn((b & d) | (c & ~d), a, b, x, s, t); }
    function hh(a: number, b: number, c: number, d: number, x: number, s: number, t: number) { return cmn(b ^ c ^ d, a, b, x, s, t); }
    function ii(a: number, b: number, c: number, d: number, x: number, s: number, t: number) { return cmn(c ^ (b | ~d), a, b, x, s, t); }
    function md5cycle(x: number[], k: number[]) {
      let [a, b, c, d] = [x[0], x[1], x[2], x[3]];
      a = ff(a, b, c, d, k[0], 7, -680876936); a = ff(d, a, b, c, k[1], 12, -389564586); a = ff(c, d, a, b, k[2], 17, 606105819); a = ff(b, c, d, a, k[3], 22, -1044525330);
      a = ff(a, b, c, d, k[4], 7, -176418897); a = ff(d, a, b, c, k[5], 12, 1200080426); a = ff(c, d, a, b, k[6], 17, -1473231341); a = ff(b, c, d, a, k[7], 22, -45705983);
      a = ff(a, b, c, d, k[8], 7, 1770035416); a = ff(d, a, b, c, k[9], 12, -1958414417); a = ff(c, d, a, b, k[10], 17, -42063); a = ff(b, c, d, a, k[11], 22, -1990404162);
      a = ff(a, b, c, d, k[12], 7, 1804603682); a = ff(d, a, b, c, k[13], 12, -40341101); a = ff(c, d, a, b, k[14], 17, -1502002290); a = ff(b, c, d, a, k[15], 22, 1236535329);
      a = gg(a, b, c, d, k[1], 5, -165796510); a = gg(d, a, b, c, k[6], 9, -1069501632); a = gg(c, d, a, b, k[11], 14, 643717713); a = gg(b, c, d, a, k[0], 20, -373897302);
      a = gg(a, b, c, d, k[5], 5, -701558691); a = gg(d, a, b, c, k[10], 9, 38016083); a = gg(c, d, a, b, k[15], 14, -660478335); a = gg(b, c, d, a, k[4], 20, -405537848);
      a = gg(a, b, c, d, k[9], 5, 568446438); a = gg(d, a, b, c, k[14], 9, -1019803690); a = gg(c, d, a, b, k[3], 14, -187363961); a = gg(b, c, d, a, k[8], 20, 1163531501);
      a = gg(a, b, c, d, k[13], 5, -1444681467); a = gg(d, a, b, c, k[2], 9, -51403784); a = gg(c, d, a, b, k[7], 14, 1735328473); a = gg(b, c, d, a, k[12], 20, -1926607734);
      a = hh(a, b, c, d, k[5], 4, -378558); a = hh(d, a, b, c, k[8], 11, -2022574463); a = hh(c, d, a, b, k[11], 16, 1839030562); a = hh(b, c, d, a, k[14], 23, -35309556);
      a = hh(a, b, c, d, k[1], 4, -1530992060); a = hh(d, a, b, c, k[4], 11, 1272893353); a = hh(c, d, a, b, k[7], 16, -155497632); a = hh(b, c, d, a, k[10], 23, -1094730640);
      a = hh(a, b, c, d, k[13], 4, 681279174); a = hh(d, a, b, c, k[0], 11, -358537222); a = hh(c, d, a, b, k[3], 16, -722521979); a = hh(b, c, d, a, k[6], 23, 76029189);
      a = hh(a, b, c, d, k[9], 4, -640364487); a = hh(d, a, b, c, k[12], 11, -421815835); a = hh(c, d, a, b, k[15], 16, 530742520); a = hh(b, c, d, a, k[2], 23, -995338651);
      a = ii(a, b, c, d, k[0], 6, -198630844); a = ii(d, a, b, c, k[7], 10, 1126891415); a = ii(c, d, a, b, k[14], 15, -1416354905); a = ii(b, c, d, a, k[5], 21, -57434055);
      a = ii(a, b, c, d, k[12], 6, 1700485571); a = ii(d, a, b, c, k[3], 10, -1894986606); a = ii(c, d, a, b, k[10], 15, -1051523); a = ii(b, c, d, a, k[1], 21, -2054922799);
      a = ii(a, b, c, d, k[8], 6, 1873313359); a = ii(d, a, b, c, k[15], 10, -30611744); a = ii(c, d, a, b, k[6], 15, -1560198380); a = ii(b, c, d, a, k[13], 21, 1309151649);
      a = ii(a, b, c, d, k[4], 6, -145523070); a = ii(d, a, b, c, k[11], 10, -1120210379); a = ii(c, d, a, b, k[2], 15, 718787259); a = ii(b, c, d, a, k[9], 21, -343485551);
      x[0] = add32(a, x[0]); x[1] = add32(b, x[1]); x[2] = add32(c, x[2]); x[3] = add32(d, x[3]);
    }
    function md5blk(s: string): number[] {
      const md5blks: number[] = [];
      for (let i = 0; i < 64; i += 4) {
        md5blks[i >> 2] = s.charCodeAt(i) + (s.charCodeAt(i + 1) << 8) + (s.charCodeAt(i + 2) << 16) + (s.charCodeAt(i + 3) << 24);
      }
      return md5blks;
    }
    function md51(s: string): number[] {
      const n = s.length;
      const state = [1732584193, -271733879, -1732584194, 271733878];
      let i: number;
      for (i = 64; i <= s.length; i += 64) md5cycle(state, md5blk(s.substring(i - 64, i)));
      s = s.substring(i - 64);
      const tail = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
      for (i = 0; i < s.length; i += 1) tail[i >> 2] |= s.charCodeAt(i) << ((i % 4) << 3);
      tail[i >> 2] |= 0x80 << ((i % 4) << 3);
      if (i > 55) { md5cycle(state, tail); for (i = 0; i < 16; i++) tail[i] = 0; }
      tail[14] = n * 8;
      md5cycle(state, tail);
      return state;
    }
    function rhex(n: number): string {
      let s = '', hex = '0123456789abcdef';
      for (let j = 0; j < 4; j++) s += hex[(n >> (j * 8 + 4)) & 0x0f] + hex[(n >> (j * 8)) & 0x0f];
      return s;
    }
    function hex(x: number[]): string { let s = ''; for (let i = 0; i < x.length; i++) s += rhex(x[i]); return s; }
    return hex(md51(s));
  }

  // ---------------- sha1 ----------------
  function sha1(s: string): string {
    function rotl(n: number, s: number) { return (n << s) | (n >>> (32 - s)); }
    function toUTF8(str: string): number[] {
      const out: number[] = [];
      for (let i = 0; i < str.length; i++) {
        let c = str.charCodeAt(i);
        if (c < 0x80) out.push(c);
        else if (c < 0x800) { out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f)); }
        else if (c < 0xd800 || c >= 0xe000) { out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f)); }
        else { i++; c = 0x10000 + (((c & 0x3ff) << 10) | (str.charCodeAt(i) & 0x3ff)); out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f)); }
      }
      return out;
    }
    const msg = toUTF8(s);
    const H = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
    msg.push(0x80);
    while (msg.length % 64 !== 56) msg.push(0);
    const lenBits = s.length * 8;
    msg.push((lenBits >>> 24) & 0xff, (lenBits >>> 16) & 0xff, (lenBits >>> 8) & 0xff, lenBits & 0xff, 0, 0, 0, 0);
    const w = new Array(80);
    for (let i = 0; i < msg.length; i += 64) {
      for (let j = 0; j < 16; j++) w[j] = (msg[i + j * 4] << 24) | (msg[i + j * 4 + 1] << 16) | (msg[i + j * 4 + 2] << 8) | msg[i + j * 4 + 3];
      for (let j = 16; j < 80; j++) w[j] = rotl(w[j - 3] ^ w[j - 8] ^ w[j - 14] ^ w[j - 16], 1);
      let [a, b, c, d, e] = H;
      for (let j = 0; j < 80; j++) {
        let f, k;
        if (j < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
        else if (j < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
        else if (j < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
        else { f = b ^ c ^ d; k = 0xca62c1d6; }
        const tmp = (rotl(a, 5) + f + e + k + (w[j] | 0)) | 0;
        e = d; d = c; c = rotl(b, 30); b = a; a = tmp;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0; H[4] = (H[4] + e) | 0;
    }
    return H.map((h) => ('00000000' + (h >>> 0).toString(16)).slice(-8)).join('');
  }

  // ---------------- sha256 ----------------
  function sha256(s: string): string {
    const K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
    function rotr(n: number, s: number) { return (n >>> s) | (n << (32 - s)); }
    function toBytes(str: string): number[] {
      const out: number[] = [];
      for (let i = 0; i < str.length; i++) {
        let c = str.charCodeAt(i);
        if (c < 0x80) out.push(c);
        else if (c < 0x800) { out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f)); }
        else if (c < 0xd800 || c >= 0xe000) { out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f)); }
        else { i++; c = 0x10000 + (((c & 0x3ff) << 10) | (str.charCodeAt(i) & 0x3ff)); out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f)); }
      }
      return out;
    }
    const msg = toBytes(s);
    const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    msg.push(0x80);
    while (msg.length % 64 !== 56) msg.push(0);
    const lenBits = s.length * 8;
    msg.push((lenBits >>> 24) & 0xff, (lenBits >>> 16) & 0xff, (lenBits >>> 8) & 0xff, lenBits & 0xff, 0, 0, 0, 0);
    const w = new Array(64);
    for (let i = 0; i < msg.length; i += 64) {
      for (let j = 0; j < 16; j++) w[j] = (msg[i + j * 4] << 24) | (msg[i + j * 4 + 1] << 16) | (msg[i + j * 4 + 2] << 8) | msg[i + j * 4 + 3];
      for (let j = 16; j < 64; j++) { const s0 = rotr(w[j - 15], 7) ^ rotr(w[j - 15], 18) ^ (w[j - 15] >>> 3); const s1 = rotr(w[j - 2], 17) ^ rotr(w[j - 2], 19) ^ (w[j - 2] >>> 10); w[j] = (w[j - 16] + s0 + w[j - 7] + s1) | 0; }
      let [a, b, c, d, e, f, g, h] = H;
      for (let j = 0; j < 64; j++) {
        const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        const ch = (e & f) ^ (~e & g);
        const t1 = (h + S1 + ch + K[j] + w[j]) | 0;
        const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + maj) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0; H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }
    return H.map((x) => ('00000000' + (x >>> 0).toString(16)).slice(-8)).join('');
  }

  return { md5, sha1, sha256 };
})();

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
      if (n3 !== -1) output += String.fromCharCode(((n2 & 15) << 4) | (n3 >> 2));
      if (n4 !== -1) output += String.fromCharCode(((n3 & 3) << 6) | n4);
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
__diag.push('crypto=' + (typeof crypto !== 'undefined'));
if (typeof __go_send === 'function') __go_send('console_log', JSON.stringify({ level: 'info', msg: '[诊断] ' + __diag.join(', ') }));

// ===== LX 协议接口（lx 与 musicApi 共享）=====
(function() {
  if (!globalThis.lx) globalThis.lx = {};
  // ★ 修复：让 musicApi 指向与 lx 完全相同的实现，兼容两种全局引用方式
  if (!globalThis.musicApi) globalThis.musicApi = globalThis.lx;
  var lx = globalThis.lx;
  var musicApi = globalThis.musicApi;

  lx.EVENT_NAMES = lx.EVENT_NAMES || { request: 'request', musicUrl: 'musicUrl', inited: 'inited', updateAlert: 'updateAlert' };
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
      md5: function(s) { try { return SYNC_CRYPTO.md5(String(s)); } catch (e) { return ''; } },
      sha1: function(s) { try { return SYNC_CRYPTO.sha1(String(s)); } catch (e) { return ''; } },
      sha256: function(s) { try { return SYNC_CRYPTO.sha256(String(s)); } catch (e) { return ''; } },
      // 若运行环境提供 Node crypto，优先使用（更可靠）
      md5Native: function(s) { try { if (typeof crypto !== 'undefined' && crypto.createHash) return crypto.createHash('md5').update(s).digest('hex'); } catch (e) {} return SYNC_CRYPTO.md5(String(s)); },
      randomBytes: function(n) { var arr = new Uint8Array(n); for (var i = 0; i < n; i++) arr[i] = Math.floor(Math.random() * 256); return arr; },
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
 * 初始化 jsenv 环境并加载音源脚本内容
 */
async function initEnv(scriptCode: string, name: string): Promise<boolean> {
  if (envReady && loadedScriptName === name) {
    logInfo(`音源环境已就绪，复用现有环境: ${name.substring(0, 60)}...`);
    return true;
  }
  logInfo(`initEnv: envReady=${envReady}, loadedScriptName=${loadedScriptName ? loadedScriptName.substring(0, 40) : 'null'}, name=${name.substring(0, 40)}...`);
  if (!scriptCode || scriptCode.length < 100) { logWarn('音源脚本内容过短或为空，可能无效'); lastInitError = '脚本内容过短'; return false; }
  try {
    if (envReady) {
      try { await songloft.jsenv.destroy(ENV_NAME); } catch { /* ignore */ }
      envReady = false; loadedScriptName = null;
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
 */
function buildRequestCode(source: string, songId: string, quality: string): string {
  return `
(function() {
  var handler = globalThis.__lx_request_handler;
  if (!handler) { __go_send('musicUrl_error', JSON.stringify({ error: 'no request handler registered (脚本未注册 musicUrl/request 处理器)' })); return; }

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
    albumId: ${JSON.stringify(songId)}
  };

  function emitResult(url) {
    if (url && typeof url === 'string' && String(url).startsWith('http')) {
      __go_send('musicUrl_result', JSON.stringify({ url: String(url).trim() }));
    } else {
      __go_send('musicUrl_error', JSON.stringify({ error: '脚本未返回有效 URL', url: url == null ? 'null' : String(url).substring(0, 200) }));
    }
  }

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
      else { __go_send('musicUrl_error', JSON.stringify({ error: '脚本回调参数为空' })); return; }
    } else {
      if (errArg) {
        var em = (errArg && errArg.message) ? errArg.message : String(errArg);
        __go_send('musicUrl_error', JSON.stringify({ error: '脚本回调报错: ' + em }));
        return;
      }
      result = dataArg;
    }
    if (result == null) { __go_send('musicUrl_error', JSON.stringify({ error: '脚本回调返回 null' })); return; }
    if (typeof result === 'string') return emitResult(result);
    if (typeof result === 'object') {
      var u = result.url || result.data || result.link || (result.body && result.body.url) || null;
      return emitResult(u);
    }
    __go_send('musicUrl_error', JSON.stringify({ error: '脚本回调返回未知类型' }));
  }

  try {
    var evt = globalThis.__lx_request_event;
    if (evt === 'musicUrl') {
      // 洛雪真实协议：handler(source, quality, musicInfo, callback)
      var ret = handler(${JSON.stringify(source)}, ${JSON.stringify(quality)}, musicInfo, cb);
      if (ret && typeof ret.then === 'function') {
        ret.then(cb).catch(function(err) {
          __go_send('musicUrl_error', JSON.stringify({ message: err && err.message ? err.message : String(err) }));
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
        ret2.then(function(u) { emitResult(u); }).catch(function(err) {
          __go_send('musicUrl_error', JSON.stringify({ message: err && err.message ? err.message : String(err) }));
        });
      } else if (typeof ret2 === 'string') {
        emitResult(ret2);
      }
    }
  } catch (e) {
    __go_send('musicUrl_error', JSON.stringify({ message: e && e.message ? e.message : String(e), stack: e && e.stack ? String(e.stack).substring(0, 500) : '' }));
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
    for (const cl of consoleLogs) {
      try { const clData = JSON.parse(cl.data); if (clData.level === 'error' || clData.level === 'warn') logWarn(`[音源脚本] ${clData.msg}`); else logInfo(`[音源脚本] ${clData.msg}`); } catch { /* ignore */ }
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
 * 按平台探测每个来源是否可用（像洛雪音源插件一样逐源检测）
 */
export async function probePlatforms(sources: SourceDescriptor[]): Promise<PlatformStatus[]> {
  const results: PlatformStatus[] = ALL_LX_SOURCES.map((s) => ({ source: s, name: LX_SOURCE_NAMES[s], status: 'unreachable' as const }));
  const set = (src: LXSource, status: PlatformStatus['status'], reason?: string) => { const r = results.find((x) => x.source === src); if (r) { r.status = status; r.reason = reason; } };
  const valid = sources.filter((s) => s && s.name);
  if (valid.length === 0) return results;
  const first = valid[0];
  const code = await first.load();
  if (!code) { for (const r of results) { r.status = 'unreachable'; r.reason = '脚本加载失败'; } return results; }
  scriptCache.set(first.name, code);
  const ok = await initEnv(code, first.name);
  if (!ok) { for (const r of results) { r.status = 'unreachable'; r.reason = '脚本初始化失败'; } return results; }
  const supported = supportedSources.length > 0 ? supportedSources : ALL_LX_SOURCES;
  const PROBE_KEYWORD = '周杰伦 晴天';
  for (const src of ALL_LX_SOURCES) {
    if (!supported.includes(src)) { set(src, 'unsupported', '脚本未启用该来源'); continue; }
    try {
      const found = await searchOnPlatform(PROBE_KEYWORD, src, 3);
      if (!found || found.length === 0) { set(src, 'fail', '搜索无结果'); continue; }
      const id = found[0].songId;
      const url = await requestMusicUrl(src, id, '128k');
      if (url) set(src, 'ok');
      else { const backendUrls = extractBackendUrls(code); set(src, 'fail', backendUrls.length > 0 ? `取URL失败（后端可能不可用: ${backendUrls.join(', ')}）` : '取URL失败（后端可能不可用）'); }
    } catch (e) { set(src, 'fail', `探测异常: ${String(e).slice(0, 60)}`); }
  }
  return results;
}
