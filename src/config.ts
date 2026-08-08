/**
 * 配置管理 — 使用 songloft.storage 持久化
 *
 * 注意：songloft.storage 的 set/get 直接存取 JS 对象，
 * 无需手动 JSON.stringify/parse。
 */
/// <reference types="@songloft/plugin-sdk" />
import { PluginConfig, DEFAULT_CONFIG } from './types';

const CONFIG_KEY = 'plugin_config';

/**
 * 加载配置，若不存在则返回默认值
 */
export async function loadConfig(): Promise<PluginConfig> {
  try {
    const raw = await songloft.storage.get(CONFIG_KEY);
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_CONFIG };
    const parsed = raw as Partial<PluginConfig>;
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch (e) {
    songloft.log.warn('加载配置失败，使用默认值: ' + String(e));
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * 保存配置（直接存储对象，SDK 自动序列化）
 */
export async function saveConfig(config: PluginConfig): Promise<void> {
  await songloft.storage.set(CONFIG_KEY, config);
  songloft.log.info('配置已保存');
}

/**
 * 验证配置是否有效
 */
export function validateConfig(config: PluginConfig): string[] {
  const errors: string[] = [];

  // 验证自定义音源 URL 列表
  if (config.customSourceUrls && config.customSourceUrls.length > 0) {
    for (let i = 0; i < config.customSourceUrls.length; i++) {
      const url = config.customSourceUrls[i].trim();
      if (!url) continue;
      try {
        const parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol)) {
          errors.push(`自定义音源 URL #${i + 1} 必须以 http:// 或 https:// 开头`);
        }
      } catch {
        errors.push(`自定义音源 URL #${i + 1} 格式不正确`);
      }
    }
  }

  // 外部 API 模式下验证 API 地址
  if (!config.useBuiltinSource && (!config.customSourceUrls || config.customSourceUrls.length === 0)) {
    if (!config.luoxueApiUrl || config.luoxueApiUrl.trim() === '') {
      errors.push('请添加自定义音源 URL、启用内置音源模式、或填写外部 API 地址');
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
