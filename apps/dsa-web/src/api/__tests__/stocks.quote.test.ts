import { beforeEach, describe, expect, it, vi } from 'vitest';
import apiClient from '../index';
import { stocksApi } from '../stocks';

vi.mock('../index', () => ({
  default: { get: vi.fn(), post: vi.fn() },
}));

describe('stocksApi.getQuote', () => {
  beforeEach(() => vi.clearAllMocks());

  it('requests the encoded quote endpoint and maps response fields', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({
      data: {
        stock_code: '600519',
        stock_name: '贵州茅台',
        current_price: 1700.5,
        change_percent: 1.25,
        prev_close: 1679.5,
        update_time: '2026-08-11T15:00:00+08:00',
      },
    });

    await expect(stocksApi.getQuote('600519.SS')).resolves.toMatchObject({
      stockCode: '600519',
      stockName: '贵州茅台',
      currentPrice: 1700.5,
      changePercent: 1.25,
    });
    expect(apiClient.get).toHaveBeenCalledWith('/api/v1/stocks/600519.SS/quote');
  });
});

describe('stocksApi.getQuotes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('requests all watchlist quotes in one batch and maps response fields', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({
      data: {
        items: [
          {
            stock_code: '600519',
            stock_name: '贵州茅台',
            current_price: 1700.5,
            change_percent: 1.25,
            source: 'tencent',
            last_success_at: '2026-08-26T09:34:59+08:00',
            is_stale: true,
            refresh_status: 'stale',
            failure_count: 1,
            next_retry_at: '2026-08-26T09:35:05+08:00',
          },
        ],
        failed_codes: ['000001'],
        update_time: '2026-08-26T09:35:00+08:00',
      },
    });

    const result = await stocksApi.getQuotes(['600519', '000001']);

    expect(apiClient.post).toHaveBeenCalledWith('/api/v1/stocks/quotes', {
      stock_codes: ['600519', '000001'],
    });
    expect(result.items[0]).toMatchObject({
      stockCode: '600519',
      currentPrice: 1700.5,
      changePercent: 1.25,
      source: 'tencent',
      lastSuccessAt: '2026-08-26T09:34:59+08:00',
      isStale: true,
      refreshStatus: 'stale',
      failureCount: 1,
    });
    expect(result.failedCodes).toEqual(['000001']);
  });

  it('loads and maps the exchange-calendar refresh policy', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({
      data: {
        market: 'cn',
        phase: 'lunch_break',
        is_trading_day: true,
        is_market_open_now: false,
        market_local_time: '2026-08-26T12:00:00+08:00',
        next_transition_at: '2026-08-26T13:00:00+08:00',
      },
    });

    await expect(stocksApi.getQuoteRefreshPolicy()).resolves.toMatchObject({
      phase: 'lunch_break',
      isTradingDay: true,
      isMarketOpenNow: false,
      nextTransitionAt: '2026-08-26T13:00:00+08:00',
    });
    expect(apiClient.get).toHaveBeenCalledWith('/api/v1/stocks/quotes/refresh-policy');
  });
});
