import { describe, expect, it } from 'vitest';
import { calculateHoldingMetrics } from '../holdingMetrics';

describe('calculateHoldingMetrics', () => {
  it('calculates market value, total P/L, return, and daily P/L', () => {
    expect(calculateHoldingMetrics({ quantity: 100, averageCost: 10, currentPrice: 12, previousClose: 11.5 })).toEqual({
      marketValue: 1200,
      totalPnl: 200,
      totalReturnPct: 20,
      dailyPnl: 50,
      dailyReturnPct: 4.3478260869565215,
      quality: 'ready',
    });
  });

  it('marks missing previous close without inventing daily P/L', () => {
    expect(calculateHoldingMetrics({ quantity: 100, averageCost: 10, currentPrice: 12 })).toMatchObject({
      marketValue: 1200,
      totalPnl: 200,
      dailyPnl: undefined,
      dailyReturnPct: undefined,
      quality: 'missing-prev-close',
    });
  });
});
