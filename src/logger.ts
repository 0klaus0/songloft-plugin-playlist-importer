/**
 * 日志记录器 — 内存环形缓冲 + 文件持久化 + 宿主转发
 *
 * 设计参考：hanxi/songloft-plugin-ytdlp 的 logger.ts
 *
 * 三路写入：
 * 1. 内存环形缓冲（权威源，快速读取，无 IO）
 * 2. JSONL 文件持久化（插件重启后恢复，带大小轮转）
 * 3. songloft.log 转发（服务端 slog 日志可见）
 *
 * HTTP API：
 *   GET  /api/logs        — 取最近日志（可选 ?limit=N）
 *   POST /api/logs/clear  — 清空日志
 */
/// <reference types="@songloft/plugin-sdk" />

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEntry {
  /** Unix 毫秒时间戳 */
  ts: number;
  level: LogLevel;
  msg: string;
}

const LOG_FILE = 'data/importer.log';
const MAX_ENTRIES = 1000;
const MAX_MSG_LEN = 2000;
const ROTATE_EVERY = 50;
const MAX_FILE_BYTES = 512 * 1024;

let buffer: LogEntry[] = [];
let writeCount = 0;
let restored = false;

function truncate(s: string): string {
  return s.length > MAX_MSG_LEN ? s.substring(0, MAX_MSG_LEN) + '...' : s;
}

function nowMs(): number {
  return Date.now();
}

/**
 * 记录一条日志（三路写入）
 */
export function log(level: LogLevel, msg: string): void {
  const entry: LogEntry = { ts: nowMs(), level, msg: truncate(String(msg)) };

  // 1. 内存缓冲
  buffer.push(entry);
  if (buffer.length > MAX_ENTRIES) {
    buffer.splice(0, buffer.length - MAX_ENTRIES);
  }

  // 2. 转发到宿主日志
  try {
    const fn = songloft.log[level] || songloft.log.info;
    fn.call(songloft.log, entry.msg);
  } catch {
    // ignore
  }

  // 3. 异步落盘
  persist(entry).catch(() => {});
}

export function logInfo(msg: string): void {
  log('info', msg);
}

export function logWarn(msg: string): void {
  log('warn', msg);
}

export function logError(msg: string): void {
  log('error', msg);
}

/**
 * 获取日志（按时间升序）
 * @param limit 最多返回条数，0=全部
 */
export function getLogs(limit: number = 0): LogEntry[] {
  if (limit > 0 && limit < buffer.length) {
    return buffer.slice(buffer.length - limit);
  }
  return [...buffer];
}

/**
 * 清空日志（内存 + 文件）
 */
export async function clearLogs(): Promise<void> {
  buffer = [];
  writeCount = 0;
  try {
    if (await songloft.fs.exists(LOG_FILE)) {
      await songloft.fs.writeFile(LOG_FILE, '', { encoding: 'utf8' });
    }
  } catch {
    // ignore
  }
}

/**
 * 异步追加日志到文件
 */
async function persist(entry: LogEntry): Promise<void> {
  try {
    await songloft.fs.appendFile(LOG_FILE, JSON.stringify(entry) + '\n', { encoding: 'utf8' });
    writeCount++;

    if (writeCount % ROTATE_EVERY === 0) {
      try {
        const st = await songloft.fs.stat(LOG_FILE);
        if (st.size > MAX_FILE_BYTES) {
          await rewriteFile();
        }
      } catch {
        // stat 失败忽略
      }
    }
  } catch {
    // 文件写入失败忽略（可能 fs 未授权或目录不存在）
  }
}

/**
 * 用内存 buffer 全量重写文件（截断）
 */
async function rewriteFile(): Promise<void> {
  try {
    const lines = buffer.map(e => JSON.stringify(e)).join('\n');
    await songloft.fs.writeFile(LOG_FILE, lines ? lines + '\n' : '', { encoding: 'utf8' });
  } catch {
    // ignore
  }
}

/**
 * 启动时从文件恢复日志到内存
 */
export async function restoreLogs(): Promise<void> {
  if (restored) return;
  restored = true;

  try {
    if (!(await songloft.fs.exists(LOG_FILE))) return;

    const content = await songloft.fs.readFile(LOG_FILE, { encoding: 'utf8' });
    const lines = content.split('\n').filter(l => l.trim() !== '');
    const tail = lines.slice(Math.max(0, lines.length - MAX_ENTRIES));

    for (const line of tail) {
      try {
        const e = JSON.parse(line) as LogEntry;
        if (typeof e.ts === 'number' && typeof e.level === 'string' && typeof e.msg === 'string') {
          buffer.push(e);
        }
      } catch {
        // 跳过损坏行
      }
    }

    if (buffer.length > 0) {
      songloft.log.info(`已恢复 ${buffer.length} 条日志`);
    }
  } catch {
    // ignore
  }
}
