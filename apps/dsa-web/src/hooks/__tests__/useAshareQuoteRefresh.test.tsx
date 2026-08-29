import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stocksApi, type StockQuoteRefreshPolicy } from '../../api/stocks';
import { useAshareQuoteRefresh } from '../useAshareQuoteRefresh';

vi.mock('../../api/stocks', () => ({
  stocksApi: {
    getQuoteRefreshPolicy: vi.fn(),
  },
}));

const openPolicy: StockQuoteRefreshPolicy = {
  market: 'cn',
  phase: 'intraday',
  isTradingDay: true,
  isMarketOpenNow: true,
  marketLocalTime: '2026-03-27T10:00:00+08:00',
  nextTransitionAt: '2026-03-27T11:30:00+08:00',
};

async function settleEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useAshareQuoteRefresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-27T02:00:00Z'));
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    Object.defineProperty(document, 'hasFocus', {
      configurable: true,
      value: () => true,
    });
    vi.mocked(stocksApi.getQuoteRefreshPolicy).mockResolvedValue(openPolicy);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('refreshes immediately and every five seconds while A shares are trading', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useAshareQuoteRefresh({
      refresh,
      refreshKey: '600519',
      isBatchAnalyzing: false,
    }));
    await settleEffects();

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(result.current.policy?.phase).toBe('intraday');
    expect(result.current.cadenceMs).toBe(5_000);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_999);
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('changes an active market timer to thirty seconds during batch analysis', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const { rerender } = renderHook(
      ({ batch }) => useAshareQuoteRefresh({
        refresh,
        refreshKey: '600519',
        isBatchAnalyzing: batch,
      }),
      { initialProps: { batch: false } },
    );
    await settleEffects();

    rerender({ batch: true });
    await settleEffects();
    expect(refresh).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(29_999);
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('pauses over lunch and resumes at the exchange transition', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    vi.setSystemTime(new Date('2026-03-27T04:00:00Z'));
    const lunchPolicy: StockQuoteRefreshPolicy = {
      ...openPolicy,
      phase: 'lunch_break',
      isMarketOpenNow: false,
      marketLocalTime: '2026-03-27T12:00:00+08:00',
      nextTransitionAt: '2026-03-27T13:00:00+08:00',
    };
    vi.mocked(stocksApi.getQuoteRefreshPolicy).mockImplementation(async () => (
      Date.now() < Date.parse('2026-03-27T05:00:00Z') ? lunchPolicy : openPolicy
    ));

    renderHook(() => useAshareQuoteRefresh({
      refresh,
      refreshKey: '600519',
      isBatchAnalyzing: false,
    }));
    await settleEffects();
    expect(refresh).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(59 * 60_000);
    });
    expect(refresh).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('keeps quote providers stopped after close, including window reactivation', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    vi.mocked(stocksApi.getQuoteRefreshPolicy).mockResolvedValue({
      ...openPolicy,
      phase: 'postmarket',
      isMarketOpenNow: false,
      marketLocalTime: '2026-03-27T16:00:00+08:00',
      nextTransitionAt: '2026-03-30T09:30:00+08:00',
    });

    renderHook(() => useAshareQuoteRefresh({
      refresh,
      refreshKey: '600519',
      isBatchAnalyzing: false,
    }));
    await settleEffects();
    expect(refresh).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    });
    expect(refresh).not.toHaveBeenCalled();

    await act(async () => {
      window.dispatchEvent(new Event('blur'));
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
    });
    expect(refresh).not.toHaveBeenCalled();
    expect(stocksApi.getQuoteRefreshPolicy).toHaveBeenCalledTimes(2);
  });

  it('does not fetch quotes on weekends when codes or focus change', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    vi.setSystemTime(new Date('2026-08-29T07:37:00Z'));
    vi.mocked(stocksApi.getQuoteRefreshPolicy).mockResolvedValue({
      ...openPolicy,
      phase: 'non_trading',
      isTradingDay: false,
      isMarketOpenNow: false,
      marketLocalTime: '2026-08-29T15:37:00+08:00',
      nextTransitionAt: '2026-08-31T09:30:00+08:00',
    });
    const { rerender } = renderHook(
      ({ refreshKey }) => useAshareQuoteRefresh({
        refresh,
        refreshKey,
        isBatchAnalyzing: false,
      }),
      { initialProps: { refreshKey: '600519' } },
    );
    await settleEffects();
    expect(refresh).not.toHaveBeenCalled();

    rerender({ refreshKey: '600519,000001' });
    await settleEffects();
    await act(async () => {
      window.dispatchEvent(new Event('blur'));
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
    });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('does not treat callback identity changes as quote refresh requests', async () => {
    const firstRefresh = vi.fn().mockResolvedValue(undefined);
    const secondRefresh = vi.fn().mockResolvedValue(undefined);
    const { rerender } = renderHook(
      ({ refresh }) => useAshareQuoteRefresh({
        refresh,
        refreshKey: '600519',
        isBatchAnalyzing: false,
      }),
      { initialProps: { refresh: firstRefresh } },
    );
    await settleEffects();
    expect(firstRefresh).toHaveBeenCalledTimes(1);

    rerender({ refresh: secondRefresh });
    await settleEffects();
    expect(secondRefresh).not.toHaveBeenCalled();
  });

  it('refreshes once when the actual watchlist codes change during trading', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const { rerender } = renderHook(
      ({ refreshKey }) => useAshareQuoteRefresh({
        refresh,
        refreshKey,
        isBatchAnalyzing: false,
      }),
      { initialProps: { refreshKey: '600519' } },
    );
    await settleEffects();
    expect(refresh).toHaveBeenCalledTimes(1);

    rerender({ refreshKey: '600519,000001' });
    await settleEffects();
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
