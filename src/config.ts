/**
 * 配置管理 — 使用 songloft.storage 持久化
 *
 * 注意：songloft.storage 的 set/get 直接存取 JS 对象，
 * 无需手动 JSON.stringify/parse。
 */
/// <reference types="@songloft/plugin-sdk" />
import { PluginConfig, DEFAULT_CONFIG } from './types';
import { logInfo, logWarn, logError } from './logger';

const CONFIG_KEY = 'plugin_config';

/** 上传的脚本文件存储键前缀（实际 key 为 SOURCE_FILE_KEY_PREFIX + id） */
export const SOURCE_FILE_KEY_PREFIX = 'source_file:';

/**
 * 加载配置，若不存在则返回默认值
 */
export async function loadConfig(): Promise<PluginConfig> {
  try {
    const raw = await songloft.storage.get(CONFIG_KEY);
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_CONFIG };
    const parsed = raw as Partial<PluginConfig>;
    const merged: PluginConfig = { ...DEFAULT_CONFIG, ...parsed };

    // 向后兼容：旧版只有 customSourceUrls，合并进 customSources
    if ((!merged.customSources || merged.customSources.length === 0) && Array.isArray(merged.customSourceUrls)) {
      merged.customSources = merged.customSourceUrls
        .map((u) => u.trim())
        .filter((u) => u.length > 0)
        .map((u) => ({ kind: 'url' as const, value: u, name: u }));
    }
    if (!Array.isArray(merged.customSources)) merged.customSources = [];

    return merged;
  } catch (e) {
    logWarn('加载配置失败，使用默认值: ' + String(e));
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * 保存配置（直接存储对象，SDK 自动序列化）
 */
export async function saveConfig(config: PluginConfig): Promise<void> {
  await songloft.storage.set(CONFIG_KEY, config);
  logInfo('配置已保存');
}

/**
 * 验证配置是否有效
 */
export function validateConfig(config: PluginConfig): string[] {
  const errors: string[] = [];

  // 验证自定义音源（URL 或上传文件）
  const sources = Array.isArray(config.customSources) ? config.customSources : [];
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    if (s.kind === 'url') {
      const url = (s.value || '').trim();
      if (!url) { errors.push(`自定义音源 #${i + 1} 地址为空`); continue; }
      try {
        const parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol)) {
          errors.push(`自定义音源 #${i + 1} 必须以 http:// 或 https:// 开头`);
        }
      } catch {
        errors.push(`自定义音源 #${i + 1} 格式不正确`);
      }
    } else if (s.kind === 'file') {
      if (!s.value) errors.push(`自定义音源 #${i + 1} 文件引用为空`);
    }
  }

  // 外部 API 模式下验证 API 地址
  if (!config.useBuiltinSource && (!config.customSources || config.customSources.length === 0)) {
    if (!config.luoxueApiUrl || config.luoxueApiUrl.trim() === '') {
      errors.push('请添加自定义音源、启用内置音源模式、或填写外部 API 地址');
    } else {
      try {
        const url = new URL(config.luoxueApiUrl);
        if (!['http:', 'https:'].includes(url.protocol)) {
          errors.push('洛雪音源 API 地址必须以 http:// 或 https:// 开头');
        }
      } catch {
        errors.push('洛雪音源 API 地址格式不正确');
      }
    }
  }
  return errors;
}

// ==================== 上传脚本文件的存储 ====================

/** 生成一个稳定的脚本文件 id（基于内容哈希，避免重复存储） */
export function makeSourceFileId(content: string): string {
  let h = 0;
  for (let i = 0; i < content.length; i++) {
    h = (h * 31 + content.charCodeAt(i)) | 0;
  }
  const base = (h >>> 0).toString(36);
  const tail = content.length.toString(36);
  return `src_${base}${tail}`;
}

/** 保存上传的脚本文件（内容存于 storage，按 id 索引） */
export async function saveUploadedSource(id: string, name: string, content: string): Promise<void> {
  await songloft.storage.set(SOURCE_FILE_KEY_PREFIX + id, { id, name, content });
  logInfo(`已保存上传音源脚本: ${name} (id=${id}, ${content.length} 字节)`);
}

/** 读取上传的脚本文件内容 */
export async function getUploadedSource(id: string): Promise<{ id: string; name: string; content: string } | null> {
  try {
    const raw = await songloft.storage.get(SOURCE_FILE_KEY_PREFIX + id);
    if (!raw || typeof raw !== 'object') return null;
    return raw as { id: string; name: string; content: string };
  } catch {
    return null;
  }
}

/** 删除上传的脚本文件 */
export async function deleteUploadedSource(id: string): Promise<void> {
  try {
    await songloft.storage.set(SOURCE_FILE_KEY_PREFIX + id, null);
  } catch {
    // 忽略
  }
  logInfo(`已删除上传音源脚本 (id=${id})`);
}
