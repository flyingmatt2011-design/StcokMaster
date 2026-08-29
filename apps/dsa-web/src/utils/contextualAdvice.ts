import type { DecisionAction } from '../types/analysis';

export type HoldingContext = 'held' | 'unheld';
export type ContextualAdvice = '加仓' | '减仓' | '持仓' | '清仓' | '建仓' | '观察' | '忽略' | '暂无建议';

function normalize(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
}

function actionFamily(action: DecisionAction | null | undefined, rawAdvice: string | null | undefined): 'buy' | 'hold' | 'reduce' | 'clear' | 'unknown' {
  if (action === 'buy' || action === 'add') return 'buy';
  if (action === 'hold' || action === 'watch') return 'hold';
  if (action === 'reduce' || action === 'sell') return 'reduce';
  if (action === 'avoid' || action === 'alert') return 'clear';

  const normalized = normalize(rawAdvice);
  if (/(强烈买入|买入|加仓|strongbuy|buy|add)/.test(normalized)) return 'buy';
  if (/(持有|观望|观察|hold|watch|observe)/.test(normalized)) return 'hold';
  if (/(清仓|强烈卖出|清除|clearsell|strongsell|sell)/.test(normalized)) return 'clear';
  if (/(减仓|reduce)/.test(normalized)) return 'reduce';
  return 'unknown';
}

export function contextualAdvice(
  action: DecisionAction | null | undefined,
  rawAdvice: string | null | undefined,
  context: HoldingContext,
): ContextualAdvice {
  const family = actionFamily(action, rawAdvice);
  if (family === 'buy') return context === 'held' ? '加仓' : '建仓';
  if (family === 'hold') return context === 'held' ? '持仓' : '观察';
  if (family === 'reduce') return context === 'held' ? '减仓' : '忽略';
  if (family === 'clear') return context === 'held' ? '清仓' : '忽略';
  return '暂无建议';
}
