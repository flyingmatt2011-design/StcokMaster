import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { UiLanguageProvider } from '../../../contexts/UiLanguageContext';
import { UI_LANGUAGE_STORAGE_KEY } from '../../../utils/uiLanguage';
import { HomeStockWorkspace } from '../HomeStockWorkspace';
import type { HomeWatchlistRow, HomeWorkspaceTab } from '../HomeStockWorkspace';
import type { AShareQuoteRefreshState } from '../../../hooks/useAshareQuoteRefresh';

function renderWorkspace({
  watchlistRows,
  selectedRecordId,
  selectedStockCode,
  activeTab = 'watchlist',
  isBatchAnalyzing = false,
  isBatchStopRequested = false,
  onStopAnalyzeWatchlist = vi.fn(),
  quoteRefreshState,
}: {
  watchlistRows: HomeWatchlistRow[];
  selectedRecordId?: number;
  selectedStockCode?: string;
  activeTab?: HomeWorkspaceTab;
  isBatchAnalyzing?: boolean;
  isBatchStopRequested?: boolean;
  onStopAnalyzeWatchlist?: () => void;
  quoteRefreshState?: AShareQuoteRefreshState;
}) {
  const onHistoryItemClick = vi.fn();
  const onRemoveFromWatchlist = vi.fn().mockResolvedValue(undefined);
  const onRefreshWatchlist = vi.fn().mockResolvedValue(undefined);
  const onAnalyzeWatchlist = vi.fn().mockResolvedValue(undefined);
  window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, 'zh');

  const renderView = (rows: HomeWatchlistRow[]) => (
    <UiLanguageProvider>
      <HomeStockWorkspace
        activeTab={activeTab}
        watchlistRows={rows}
        watchlistLoading={false}
        watchlistActioning={false}
        watchlistMessage={null}
        onAddToWatchlist={vi.fn().mockResolvedValue(undefined)}
        onRemoveFromWatchlist={onRemoveFromWatchlist}
        onRefreshWatchlist={onRefreshWatchlist}
        onAnalyzeWatchlist={onAnalyzeWatchlist}
        onStopAnalyzeWatchlist={onStopAnalyzeWatchlist}
        isBatchAnalyzing={isBatchAnalyzing}
        isBatchStopRequested={isBatchStopRequested}
        batchStatus={null}
        quoteRefreshState={quoteRefreshState}
        todayItems={[]}
        isLoadingTodayItems={false}
        todayLoadError={false}
        historyItems={[]}
        isLoadingHistory={false}
        selectedStockCode={selectedStockCode}
        selectedRecordId={selectedRecordId}
        onHistoryItemClick={onHistoryItemClick}
      />
    </UiLanguageProvider>
  );
  const view = render(renderView(watchlistRows));

  return {
    onHistoryItemClick,
    onRemoveFromWatchlist,
    onRefreshWatchlist,
    onAnalyzeWatchlist,
    onStopAnalyzeWatchlist,
    rerenderWatchlistRows: (rows: HomeWatchlistRow[]) => view.rerender(renderView(rows)),
  };
}

describe('HomeStockWorkspace', () => {
  it('supports selecting one or more watchlist stocks for analysis', () => {
    const { onAnalyzeWatchlist } = renderWorkspace({
      watchlistRows: [
        { code: '600519', analyzedToday: false },
        { code: '000001', analyzedToday: true },
        { code: 'AAPL', analyzedToday: false },
      ],
    });

    fireEvent.click(screen.getByTestId('watchlist-select-600519'));
    fireEvent.click(screen.getByTestId('watchlist-select-AAPL'));

    expect(screen.getByTestId('watchlist-selected-count')).toHaveTextContent('2');
    fireEvent.click(screen.getByTestId('watchlist-analyze-selected'));

    expect(onAnalyzeWatchlist).toHaveBeenCalledWith('selected', ['600519', 'AAPL']);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('selects all current watchlist stocks from the header control', () => {
    const { onAnalyzeWatchlist } = renderWorkspace({
      watchlistRows: [
        { code: '600519', analyzedToday: false },
        { code: '000001', analyzedToday: true },
      ],
    });

    fireEvent.click(screen.getByTestId('watchlist-select-all'));
    expect(screen.getByTestId('watchlist-selected-count')).toHaveTextContent('2');
    expect(screen.getByTestId('watchlist-select-600519')).toBeChecked();
    expect(screen.getByTestId('watchlist-select-000001')).toBeChecked();

    fireEvent.click(screen.getByTestId('watchlist-analyze-selected'));
    expect(onAnalyzeWatchlist).toHaveBeenCalledWith('selected', ['600519', '000001']);
  });

  it('shows stocks score-first and exposes terminal signal filters', () => {
    renderWorkspace({ watchlistRows: [
      { code: 'LOW', analyzedToday: true, isHeld: false, latestItem: { id: 1, stockCode: 'LOW', stockName: '低分股', sentimentScore: 40, changePct: -1, analysisCount: 1, lastAnalysisTime: '2026-03-18T09:00:00+08:00' } },
      { code: 'HIGH', analyzedToday: true, isHeld: true, latestItem: { id: 2, stockCode: 'HIGH', stockName: '高分股', sentimentScore: 80, changePct: 2, analysisCount: 1, lastAnalysisTime: '2026-03-19T09:00:00+08:00' } },
    ] });

    const rows = screen.getAllByTestId(/watchlist-row-/);
    expect(rows[0]).toHaveAttribute('data-testid', 'watchlist-row-HIGH');
    expect(screen.getByTestId('watchlist-row-HIGH')).toBeInTheDocument();
    expect(screen.getByTestId('watchlist-row-LOW')).toBeInTheDocument();
    expect(screen.queryByLabelText('自选股排序')).not.toBeInTheDocument();
    expect(screen.getByLabelText('自选股筛选')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '自选股盯盘' })).toBeInTheDocument();
    expect(screen.getByText('2 只 · 默认按评分排序')).toBeInTheDocument();
  });

  it('keeps the watchlist count and refresh action in a separate heading row', () => {
    const { onRefreshWatchlist } = renderWorkspace({
      watchlistRows: [
        { code: '600519', analyzedToday: true },
        { code: '000001', analyzedToday: false },
      ],
    });

    expect(screen.getByRole('heading', { name: '自选股盯盘' })).toBeInTheDocument();
    expect(screen.getByText('2 只 · 默认按评分排序')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '刷新自选股列表' }));
    expect(onRefreshWatchlist).toHaveBeenCalledTimes(1);
  });

  it('shows quote refresh cadence, source, and stale state without replacing analysis time', () => {
    renderWorkspace({
      quoteRefreshState: {
        policy: {
          market: 'cn',
          phase: 'intraday',
          isTradingDay: true,
          isMarketOpenNow: true,
          marketLocalTime: '2026-03-19T10:00:00+08:00',
          nextTransitionAt: '2026-03-19T11:30:00+08:00',
        },
        policyUnavailable: false,
        cadenceMs: 5_000,
      },
      watchlistRows: [{
        code: '600519',
        analyzedToday: true,
        quote: {
          stockCode: '600519',
          stockName: '贵州茅台',
          currentPrice: 1700.5,
          source: 'tencent',
          lastSuccessAt: '2026-03-19T09:59:55+08:00',
          isStale: true,
          refreshStatus: 'stale',
        },
        latestItem: {
          id: 21,
          stockCode: '600519',
          stockName: '贵州茅台',
          analysisCount: 1,
          lastAnalysisTime: '2026-03-19T09:00:00+08:00',
        },
      }],
    });

    expect(screen.getByTestId('watchlist-quote-refresh-status')).toHaveTextContent('交易中 · 5秒刷新');
    expect(screen.getByTestId('watchlist-row-600519')).toHaveTextContent('腾讯 · 旧行情');
    expect(screen.getByLabelText('最近分析 2026/03/19 09:00')).toHaveTextContent('03/19 09:00');
  });

  it('shows a stop action while a batch is running', () => {
    const onStopAnalyzeWatchlist = vi.fn();
    renderWorkspace({ watchlistRows: [], isBatchAnalyzing: true, onStopAnalyzeWatchlist });

    fireEvent.click(screen.getByTestId('watchlist-stop-analysis'));
    expect(onStopAnalyzeWatchlist).toHaveBeenCalledTimes(1);
  });

  it('uses the terminal table scroll contract for watchlist content', () => {
    renderWorkspace({ watchlistRows: [] });

    const workspace = screen.getByTestId('home-stock-workspace');
    expect(workspace).toHaveClass('terminal-watchlist-board');
    expect(workspace).toHaveAttribute('data-density', 'terminal');
    expect(workspace).not.toHaveClass('overflow-hidden');
    expect(workspace.querySelector('.terminal-table-scroll')).toBeInTheDocument();
  });

  it('keeps history inside the terminal history surface', () => {
    renderWorkspace({ watchlistRows: [], activeTab: 'history' });

    const workspace = screen.getByTestId('home-stock-workspace');
    const stockBar = screen.getByTestId('home-stock-bar');
    expect(workspace).toHaveClass('terminal-watchlist-history');
    expect(workspace).not.toHaveClass('overflow-hidden');
    expect(stockBar).toHaveClass('h-full');
  });

  it('opens the latest watchlist detail from a native button and keeps the row selected', () => {
    const { onHistoryItemClick } = renderWorkspace({
      watchlistRows: [{
        code: '600519',
        analyzedToday: true,
        latestItem: {
          id: 21,
          stockCode: '600519',
          stockName: '贵州茅台',
          sentimentScore: 88,
          operationAdvice: '买入',
          analysisCount: 1,
          lastAnalysisTime: '2026-03-19T09:00:00+08:00',
        },
      }],
      selectedRecordId: 21,
    });

    const row = screen.getByRole('button', { name: '打开 600519 最新分析详情' });
    const stockName = screen.getByText('贵州茅台');
    expect(stockName).toHaveTextContent('贵州茅台');
    expect(screen.getByTestId('watchlist-row-600519')).toHaveTextContent('88');
    expect(screen.getByLabelText('最近分析 2026/03/19 09:00')).toHaveTextContent('03/19 09:00');
    fireEvent.click(row);

    expect(onHistoryItemClick).toHaveBeenCalledWith(21);
    expect(row.tagName).toBe('BUTTON');
    expect(row).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows strategy points and MA5 deviation from the latest analysis', () => {
    renderWorkspace({
      watchlistRows: [{
        code: '600519',
        analyzedToday: true,
        latestItem: {
          id: 21,
          stockCode: '600519',
          stockName: '贵州茅台',
          idealBuy: '理想买入点：1420.50 元附近',
          stopLoss: '止损位 1368.00',
          biasMa5: -2.35,
          analysisCount: 1,
          lastAnalysisTime: '2026-03-19T09:00:00+08:00',
        },
      }],
    });

    const row = screen.getByTestId('watchlist-row-600519');
    expect(row).toHaveTextContent('1420.50');
    expect(row).toHaveTextContent('1368.00');
    expect(row).toHaveTextContent('-2.35%');
  });

  it('opens the latest watchlist detail when clicking the score area of the row', () => {
    const { onHistoryItemClick } = renderWorkspace({
      watchlistRows: [{
        code: '600519',
        analyzedToday: true,
        latestItem: {
          id: 21,
          stockCode: '600519',
          stockName: '贵州茅台',
          sentimentScore: 88,
          operationAdvice: '买入',
          analysisCount: 1,
          lastAnalysisTime: '2026-03-19T09:00:00+08:00',
        },
      }],
    });

    const row = screen.getByTestId('watchlist-row-600519');
    fireEvent.click(row.querySelector('.terminal-score') as HTMLElement);

    expect(onHistoryItemClick).toHaveBeenCalledWith(21);
  });

  it('shows an explicit notice when a watchlist row has no detail yet', async () => {
    const { onHistoryItemClick } = renderWorkspace({
      watchlistRows: [{
        code: 'AAPL',
        analyzedToday: false,
      }],
    });

    const row = screen.getByRole('button', { name: '暂无 AAPL 的分析详情，可先分析' });
    fireEvent.click(row);

    expect(await screen.findByRole('alert')).toHaveTextContent('暂无分析详情，可先分析。');
    expect(onHistoryItemClick).not.toHaveBeenCalled();
  });

  it('shows loading feedback instead of no-detail copy while latest detail lookup is still pending', async () => {
    const { onHistoryItemClick } = renderWorkspace({
      watchlistRows: [{
        code: 'AAPL',
        analyzedToday: false,
        isTodayStatusLoading: true,
      }],
    });

    const row = screen.getByRole('button', { name: '正在查找 AAPL 的最新分析详情' });
    fireEvent.click(row);

    expect(await screen.findByRole('alert')).toHaveTextContent('正在查找最新分析详情，请稍候。');
    expect(onHistoryItemClick).not.toHaveBeenCalled();
    expect(screen.getByText('正在查找详情...')).toBeInTheDocument();
  });

  it('shows retry feedback instead of no-detail copy when the latest detail lookup failed', async () => {
    const { onHistoryItemClick } = renderWorkspace({
      watchlistRows: [{
        code: 'AAPL',
        analyzedToday: false,
        isTodayStatusUnknown: true,
      }],
    });

    const row = screen.getByRole('button', { name: 'AAPL 的最新分析详情暂时无法确认，请稍后重试' });
    fireEvent.click(row);

    expect(await screen.findByRole('alert')).toHaveTextContent('最新分析详情暂时无法确认，请稍后重试。');
    expect(screen.queryByText('暂无分析详情，可先分析。')).not.toBeInTheDocument();
    expect(screen.getByText('详情暂不可用')).toBeInTheDocument();
    expect(onHistoryItemClick).not.toHaveBeenCalled();
  });

  it('does not expose a cached detail while the current row status is unsettled', async () => {
    const cachedItem = {
      id: 24,
      stockCode: 'AAPL',
      stockName: 'Apple',
      sentimentScore: 68,
      operationAdvice: 'neutral',
      analysisCount: 1,
      lastAnalysisTime: '2026-03-18T09:20:00+08:00',
    };
    const { onHistoryItemClick, rerenderWatchlistRows } = renderWorkspace({
      watchlistRows: [{
        code: 'AAPL',
        analyzedToday: false,
        latestItem: cachedItem,
        isTodayStatusLoading: true,
      }],
    });

    fireEvent.click(screen.getByRole('button', { name: '\u6b63\u5728\u67e5\u627e AAPL \u7684\u6700\u65b0\u5206\u6790\u8be6\u60c5' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('\u6b63\u5728\u67e5\u627e\u6700\u65b0\u5206\u6790\u8be6\u60c5\uff0c\u8bf7\u7a0d\u5019\u3002');
    expect(onHistoryItemClick).not.toHaveBeenCalled();

    rerenderWatchlistRows([{
      code: 'AAPL',
      analyzedToday: false,
      latestItem: cachedItem,
      isTodayStatusUnknown: true,
    }]);
    fireEvent.click(screen.getByRole('button', { name: 'AAPL \u7684\u6700\u65b0\u5206\u6790\u8be6\u60c5\u6682\u65f6\u65e0\u6cd5\u786e\u8ba4\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5' }));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('\u6700\u65b0\u5206\u6790\u8be6\u60c5\u6682\u65f6\u65e0\u6cd5\u786e\u8ba4\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5\u3002');
    });
    expect(onHistoryItemClick).not.toHaveBeenCalled();
  });

  it('clears a loading notice when the same row detail lookup settles', async () => {
    const { rerenderWatchlistRows } = renderWorkspace({
      watchlistRows: [{
        code: 'AAPL',
        analyzedToday: false,
        isTodayStatusLoading: true,
      }],
    });

    const row = screen.getByTestId('watchlist-row-AAPL');
    fireEvent.click(row.querySelector('button[aria-pressed]') as HTMLButtonElement);
    expect(await screen.findByRole('alert')).toBeInTheDocument();

    rerenderWatchlistRows([{
      code: 'AAPL',
      analyzedToday: false,
      latestItem: {
        id: 22,
        stockCode: 'AAPL',
        stockName: 'Apple',
        sentimentScore: 72,
        operationAdvice: 'neutral',
        analysisCount: 1,
        lastAnalysisTime: '2026-03-19T09:00:00+08:00',
      },
    }]);

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(row.querySelector('button[aria-pressed]')).toBeInTheDocument();
  });

  it('clears a no-detail notice when the matching row receives a detail', async () => {
    const { rerenderWatchlistRows } = renderWorkspace({
      watchlistRows: [{
        code: 'AAPL',
        analyzedToday: false,
      }],
    });

    fireEvent.click(screen.getByRole('button', { name: '暂无 AAPL 的分析详情，可先分析' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('暂无分析详情，可先分析。');

    rerenderWatchlistRows([{
      code: 'AAPL',
      analyzedToday: true,
      latestItem: {
        id: 23,
        stockCode: 'AAPL',
        stockName: 'Apple',
        sentimentScore: 80,
        operationAdvice: 'buy',
        analysisCount: 1,
        lastAnalysisTime: '2026-03-19T10:00:00+08:00',
      },
    }]);

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: '打开 AAPL 最新分析详情' })).toBeInTheDocument();
  });

  it('derives an opened notice from the latest row state instead of retaining stale copy', async () => {
    const { rerenderWatchlistRows } = renderWorkspace({
      watchlistRows: [{
        code: 'AAPL',
        analyzedToday: false,
      }],
    });

    const row = screen.getByTestId('watchlist-row-AAPL');
    fireEvent.click(row.querySelector('button[aria-pressed]') as HTMLButtonElement);
    expect(await screen.findByRole('alert')).toHaveTextContent('\u6682\u65e0\u5206\u6790\u8be6\u60c5\uff0c\u53ef\u5148\u5206\u6790\u3002');

    rerenderWatchlistRows([{
      code: 'AAPL',
      analyzedToday: false,
      isTodayStatusLoading: true,
    }]);
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('\u6b63\u5728\u67e5\u627e\u6700\u65b0\u5206\u6790\u8be6\u60c5\uff0c\u8bf7\u7a0d\u5019\u3002');
    });

    rerenderWatchlistRows([{
      code: 'AAPL',
      analyzedToday: false,
      isTodayStatusUnknown: true,
    }]);
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('\u6700\u65b0\u5206\u6790\u8be6\u60c5\u6682\u65f6\u65e0\u6cd5\u786e\u8ba4\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5\u3002');
    });
  });

  it('does not bubble delete clicks into detail opening', async () => {
    const { onHistoryItemClick, onRemoveFromWatchlist } = renderWorkspace({
      watchlistRows: [{
        code: '600519',
        analyzedToday: true,
        latestItem: {
          id: 21,
          stockCode: '600519',
          stockName: '贵州茅台',
          sentimentScore: 88,
          operationAdvice: '买入',
          analysisCount: 1,
          lastAnalysisTime: '2026-03-19T09:00:00+08:00',
        },
      }],
    });

    fireEvent.click(screen.getByRole('button', { name: '从自选股移除 600519' }));

    expect(onRemoveFromWatchlist).toHaveBeenCalledWith('600519');
    expect(onHistoryItemClick).not.toHaveBeenCalled();
  });

  it('keeps the watchlist row selected for equivalent stock-code formats', () => {
    renderWorkspace({
      watchlistRows: [{
        code: 'HK700',
        analyzedToday: true,
        latestItem: {
          id: 88,
          stockCode: '00700',
          stockName: '腾讯控股',
          sentimentScore: 91,
          operationAdvice: '买入',
          analysisCount: 1,
          lastAnalysisTime: '2026-03-19T09:00:00+08:00',
        },
      }],
      selectedStockCode: '00700.HK',
    });

    expect(screen.getByRole('button', { name: '打开 HK700 最新分析详情' })).toHaveAttribute('aria-pressed', 'true');
  });
});
