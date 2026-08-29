import { describe, expect, it } from 'vitest';
import { contextualAdvice } from '../contextualAdvice';

describe('contextualAdvice', () => {
  it.each([
    ['buy', 'held', '加仓'],
    ['buy', 'unheld', '建仓'],
    ['hold', 'held', '持仓'],
    ['watch', 'unheld', '观察'],
    ['reduce', 'held', '减仓'],
    ['sell', 'unheld', '忽略'],
    ['avoid', 'held', '清仓'],
  ] as const)('%s maps to %s for %s', (action, context, expected) => {
    expect(contextualAdvice(action as never, null, context)).toBe(expected);
  });

  it('uses raw upstream advice only as a compatibility fallback', () => {
    expect(contextualAdvice(null, '强烈买入', 'unheld')).toBe('建仓');
    expect(contextualAdvice(null, '观望', 'held')).toBe('持仓');
  });

  it('does not invent a recommendation when upstream action is missing', () => {
    expect(contextualAdvice(null, null, 'held')).toBe('暂无建议');
  });
});
