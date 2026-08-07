/**
 * 配置管理 — 使用 songloft.storage 持久化
 */
import { PluginConfig, DEFAULT_CONFIG } from './types';

const CONFIG_KEY = 'plugin_config';

/**
 * 載入配置，若不存在則回傳預設值
 */
export async function loadConfig(): Promise<PluginConfig> {
  try {
    const raw = await songloft.storage.get(CONFIG_KEY);
    if (!raw) return { ...DEFAULT_CONFIG };
    const parsed = JSON.parse(raw) as Partial<PluginConfig>;
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch (e) {
    songloft.log.warn('載入配置失敗，使用預設值: ' + String(e));
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * 儲存配置
 */
export async function saveConfig(config: PluginConfig): Promise<void> {
  const raw = JSON.stringify(config);
  await songloft.storage.set(CONFIG_KEY, raw);
  songloft.log.info('配置已儲存');
}

/**
 * 驗證配置是否有效
 */
export function validateConfig(config: PluginConfig): string[] {
  const errors: string[] = [];
  if (!config.luoxueApiUrl || config.luoxueApiUrl.trim() === '') {
    errors.push('洛雪音源 API 位址不能為空');
  } else {
    try {
      const url = new URL(config.luoxueApiUrl);
      if (!['http:', 'https:'].includes(url.protocol)) {
        errors.push('洛雪音源 API 位址必須以 http:// 或 https:// 開頭');
      }
    } catch {
      errors.push('洛雪音源 API 位址格式不正確');
    }
  }
  return errors;
}
