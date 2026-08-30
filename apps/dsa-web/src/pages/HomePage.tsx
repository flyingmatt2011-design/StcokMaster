import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Bell, BellOff, X } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { getParsedApiError, type ParsedApiError } from '../api/error';
import { analysisApi, DuplicateTaskError } from '../api/analysis';
import { historyApi } from '../api/history';
import { portfolioApi } from '../api/portfolio';
import { systemConfigApi } from '../api/systemConfig';
import { stocksApi, type StockQuote } from '../api/stocks';
import { ApiErrorAlert, Button, Drawer, EmptyState, InlineAlert } from '../components/common';
import { DashboardStateBlock } from '../components/dashboard';
import { StockHistoryTrendDrawer } from '../components/history';
import { ReportMarkdownDrawer } from '../components/report/ReportMarkdownDrawer';
import { MarketReviewReportView } from '../components/report/MarketReviewReportView';
import { ReportChatPanel } from '../components/report/ReportChatPanel';
import { ReportSummary } from '../components/report/ReportSummary';
import { StockAutocomplete } from '../components/StockAutocomplete';
import { MarketReviewRegionSelector } from '../components/market-review/MarketReviewRegionSelector';
import { RunFlowPanel } from '../components/run-flow';
import { AnalysisStatusBar, TaskPanel } from '../components/tasks';
import {
  HomeStockWorkspace,
  type HomeWatchlistRow,
  type HomeWorkspaceTab,
  type WatchlistAnalyzeMode,
} from '../components/watchlist/HomeStockWorkspace';
import { useAshareQuoteRefresh, useDashboardLifecycle, useHomeDashboardState } from '../hooks';
import { useWatchlist } from '../hooks/useWatchlist';
import { useUiLanguage } from '../contexts/UiLanguageContext';
import type { SetupStatusResponse } from '../types/systemConfig';
import { normalizeReportLanguage } from '../utils/reportLanguage';
import type {
  HistoryItem,
  MarketReviewPayload,
  MarketReviewRegion,
  StockBarItem,
  TaskInfo,
} from '../types/analysis';
import type { RunFlowSnapshotSource } from '../types/runFlow';
import { getTodayInShanghai } from '../utils/format';
import { normalizeStockCode } from '../utils/stockCode';
import { runWatchlistBatchAnalysis, waitForWatchlistTask } from '../utils/watchlistBatchAnalysis';

type MarketReviewNotice = {
  variant: 'success' | 'warning' | 'danger';
  title: string;
  message: string;
} | null;

type RunFlowDrawerState =
  | { open: false }
  | { open: true; source: RunFlowSnapshotSource; title: string };

type StockAnalysisNavigationState = {
  stockCode?: string;
  stockName?: string;
  autoAnalyze?: boolean;
  selectionSource?: string;
  skills?: string[];
};

const DUPLICATE_BANNER_AUTO_DISMISS_MS = 5000;
const TODAY_ANALYSIS_PAGE_SIZE = 100;
const WATCHLIST_HISTORY_LOOKUP_CONCURRENCY = 4;
const WATCHLIST_ANALYSIS_CONCURRENCY = 2;
const TASK_PANEL_COLLAPSED_STORAGE_KEY = 'dsa.home.taskPanelCollapsed';
const WATCHLIST_BATCH_RECOVERY_STORAGE_KEY = 'stockmaster.watchlistBatchRecovery';
const MARKET_DASHBOARD_REFRESH_INTERVAL_MS = 5 * 60_000;
const SERVER_LOCAL_DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/;

function isDashboardWindowActive(): boolean {
  return document.visibilityState === 'visible'
    && (typeof document.hasFocus !== 'function' || document.hasFocus());
}

type BatchAnalyzeStatus = {
  variant: 'success' | 'warning' | 'danger';
  message: string;
} | null;

type WatchlistHistoryLookupState = {
  signature: string;
  settledKeys: Set<string>;
  failedKeys: Set<string>;
};

type WatchlistHistoryLookupResult = {
  code: string;
  item: HistoryItem | null;
  failed: boolean;
};

async function lookupWatchlistHistory(
  codes: string[],
  isCanceled: () => boolean,
  signal: AbortSignal,
): Promise<WatchlistHistoryLookupResult[]> {
  const results: Array<WatchlistHistoryLookupResult | undefined> = new Array(codes.length);
  let nextIndex = 0;

  const runWorker = async () => {
    while (!isCanceled()) {
      const index = nextIndex;
      if (index >= codes.length) {
        return;
      }
      nextIndex += 1;
      const code = codes[index];
      try {
        const response = await historyApi.getList(
          { stockCode: code, limit: 1 },
          { signal },
        );
        results[index] = { code, item: response.items[0] ?? null, failed: false };
      } catch {
        results[index] = { code, item: null, failed: true };
      }
    }
  };

  const workerCount = Math.min(WATCHLIST_HISTORY_LOOKUP_CONCURRENCY, codes.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results.filter((entry): entry is WatchlistHistoryLookupResult => entry !== undefined);
}

function getShanghaiDateKey(value?: string | null): string {
  if (!value) return '';
  const trimmed = value.trim();
  const normalized = SERVER_LOCAL_DATE_TIME_PATTERN.test(trimmed)
    ? `${trimmed.replace(' ', 'T')}+08:00`
    : trimmed;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(date);
}

function getShanghaiTimeValue(value?: string | null): number {
  if (!value) return 0;
  const trimmed = value.trim();
  const normalized = SERVER_LOCAL_DATE_TIME_PATTERN.test(trimmed)
    ? `${trimmed.replace(' ', 'T')}+08:00`
    : trimmed;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function shiftDateKey(dateKey: string, days: number): string {
  const date = new Date(`${dateKey}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function getStockCodeKey(code?: string | null): string {
  const trimmed = (code ?? '').trim();
  return trimmed ? normalizeStockCode(trimmed).toUpperCase() : '';
}

function readTaskPanelCollapsedPreference(): boolean | null {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    const rawValue = window.sessionStorage.getItem(TASK_PANEL_COLLAPSED_STORAGE_KEY);
    if (rawValue === 'true') return true;
    if (rawValue === 'false') return false;
    return null;
  } catch {
    return null;
  }
}

function writeTaskPanelCollapsedPreference(collapsed: boolean): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.sessionStorage.setItem(TASK_PANEL_COLLAPSED_STORAGE_KEY, String(collapsed));
  } catch {
    // Session storage is best-effort; keep the in-memory toggle state working.
  }
}

function toStockBarItemFromHistoryItem(item: HistoryItem): StockBarItem {
  return {
    id: item.id,
    stockCode: item.stockCode,
    stockName: item.stockName,
    reportType: item.reportType,
    sentimentScore: item.sentimentScore,
    operationAdvice: item.operationAdvice,
    action: item.action ?? null,
    actionLabel: item.actionLabel ?? null,
    currentPrice: item.currentPrice,
    changePct: item.changePct,
    trendPrediction: item.trendPrediction,
    idealBuy: item.idealBuy,
    stopLoss: item.stopLoss,
    biasMa5: item.biasMa5,
    analysisCount: 0,
    lastAnalysisTime: item.createdAt,
    modelUsed: item.modelUsed,
    marketPhaseSummary: item.marketPhaseSummary ?? null,
  };
}

async function getTodayAnalysisItems(dateKey: string): Promise<StockBarItem[]> {
  const items: StockBarItem[] = [];
  let loadedRecordCount = 0;
  let page = 1;

  while (true) {
    const response = await historyApi.getList({
      // History dates are filtered in the server's local timezone. Query the
      // adjacent dates too, then apply the exact Shanghai-day filter below.
      startDate: shiftDateKey(dateKey, -1),
      endDate: shiftDateKey(dateKey, 1),
      page,
      limit: TODAY_ANALYSIS_PAGE_SIZE,
    });

    loadedRecordCount += response.items.length;
    for (const item of response.items) {
      if (item.stockCode === 'MARKET' || item.reportType === 'market_review') {
        continue;
      }
      items.push(toStockBarItemFromHistoryItem(item));
    }

    if (
      response.items.length === 0
      || response.items.length < TODAY_ANALYSIS_PAGE_SIZE
      || loadedRecordCount >= response.total
    ) {
      break;
    }

    page += 1;
  }

  return items;
}

const HomePage: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { language: uiLanguage, t } = useUiLanguage();
  const [isDetailViewOpen, setIsDetailViewOpen] = useState(false);
  const [isSubmittingMarketReview, setIsSubmittingMarketReview] = useState(false);
  const [marketReviewNotice, setMarketReviewNotice] = useState<MarketReviewNotice>(null);
  const [marketReviewError, setMarketReviewError] = useState<ParsedApiError | null>(null);
  const [marketReviewReport, setMarketReviewReport] = useState<string | null>(null);
  const [marketReviewPayload, setMarketReviewPayload] = useState<MarketReviewPayload | null>(null);
  const [marketReviewRegionOverride, setMarketReviewRegionOverride] = useState<MarketReviewRegion[] | undefined>();
  const [runFlowDrawer, setRunFlowDrawer] = useState<RunFlowDrawerState>({ open: false });
  const [duplicateBannerVisible, setDuplicateBannerVisible] = useState(false);
  const [sidebarWorkspaceTab, setSidebarWorkspaceTab] = useState<HomeWorkspaceTab>('watchlist');
  const [isTaskPanelCollapsed, setIsTaskPanelCollapsed] = useState<boolean>(() => (
    readTaskPanelCollapsedPreference() ?? false
  ));
  const [isBatchAnalyzingWatchlist, setIsBatchAnalyzingWatchlist] = useState(false);
  const [isBatchStopRequested, setIsBatchStopRequested] = useState(false);
  const [batchAnalyzeStatus, setBatchAnalyzeStatus] = useState<BatchAnalyzeStatus>(null);
  const [heldStockKeys, setHeldStockKeys] = useState<Set<string>>(new Set());
  const [watchlistHistoryItemsByCode, setWatchlistHistoryItemsByCode] = useState<Map<string, StockBarItem>>(new Map());
  const [watchlistHistoryLookupState, setWatchlistHistoryLookupState] = useState<WatchlistHistoryLookupState>({
    signature: '',
    settledKeys: new Set(),
    failedKeys: new Set(),
  });
  const [watchlistHistoryRetryVersion, setWatchlistHistoryRetryVersion] = useState(0);
  const [todayHistoryItems, setTodayHistoryItems] = useState<StockBarItem[]>([]);
  const [isLoadingTodayAnalysisItems, setIsLoadingTodayAnalysisItems] = useState(false);
  const [todayAnalysisLoadFailed, setTodayAnalysisLoadFailed] = useState(false);
  const [todayAnalysisRefreshVersion, setTodayAnalysisRefreshVersion] = useState(0);
  const [watchlistQuotesByCode, setWatchlistQuotesByCode] = useState<Map<string, StockQuote>>(new Map());
  const [isStockBarInitialLoadSettled, setIsStockBarInitialLoadSettled] = useState(false);
  const [completedTaskRefreshPendingCounts, setCompletedTaskRefreshPendingCounts] = useState<Map<string, number>>(
    new Map(),
  );
  const duplicateBannerTimer = useRef<number | null>(null);
  const marketReviewPollTimer = useRef<number | null>(null);
  const marketSnapshotRefreshPromiseRef = useRef<Promise<void> | null>(null);
  const marketSnapshotRefreshedAtRef = useRef(0);
  const suppressLiveMarketRefreshRef = useRef(false);
  const watchlistQuoteRefreshPromiseRef = useRef<Promise<void> | null>(null);
  const stockBarLoadStartedRef = useRef(false);
  const taskPanelPreferenceSettledRef = useRef(readTaskPanelCollapsedPreference() !== null);
  const dashboardScrollRef = useRef<HTMLElement | null>(null);
  const batchStopRequestedRef = useRef(false);
  const batchRecoveryStartedRef = useRef(false);

  const stopMarketReviewPolling = useCallback(() => {
    if (marketReviewPollTimer.current !== null) {
      window.clearInterval(marketReviewPollTimer.current);
      marketReviewPollTimer.current = null;
    }
  }, []);

  const scrollMarketReviewFeedbackIntoView = useCallback(() => {
    const scrollContainer = dashboardScrollRef.current;
    if (!scrollContainer) {
      return;
    }

    if (typeof scrollContainer.scrollTo === 'function') {
      scrollContainer.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }

    scrollContainer.scrollTop = 0;
  }, []);

  useEffect(() => stopMarketReviewPolling, [stopMarketReviewPolling]);
  useEffect(() => {
    let active = true;
    void portfolioApi.getSnapshot({ includeRealtime: false })
      .then((snapshot) => {
        if (!active) return;
        setHeldStockKeys(new Set(
          snapshot.accounts
            .flatMap((account) => account.positions)
            .filter((position) => position.quantity > 0)
            .map((position) => getStockCodeKey(position.symbol))
            .filter(Boolean),
        ));
      })
      .catch(() => {
        if (active) setHeldStockKeys(new Set());
      });
    return () => { active = false; };
  }, []);
  const [setupStatus, setSetupStatus] = useState<SetupStatusResponse | null>(null);

  const {
    query,
    inputError,
    duplicateError,
    error,
    isAnalyzing,
    selectedReport,
    isLoadingReport,
    isHistoryTrendOpen,
    marketReviewHistoryItems,
    stockHistoryItems,
    stockHistoryTotal,
    stockHistoryHasMore,
    isLoadingStockHistory,
    isLoadingMoreStockHistory,
    stockHistoryError,
    stockHistoryFilters,
    activeTasks,
    markdownDrawerOpen,
    setQuery,
    clearError,
    loadInitialHistory,
    refreshHistory,
    refreshHistoryForCompletedTask,
    loadMarketReviewHistory,
    refreshMarketReviewHistory,
    selectHistoryItem,
    submitAnalysis,
    notify,
    setNotify,
    syncTaskCreated,
    syncTaskUpdated,
    syncTaskFailed,
    refreshActiveTasks,
    removeTask,
    openMarkdownDrawer,
    closeMarkdownDrawer,
    openHistoryTrend,
    closeHistoryTrend,
    setStockHistoryRange,
    loadMoreStockHistory,
    stockBarItems,
    isLoadingStockBar,
    stockBarRefreshFailed,
    loadStockBar,
    refreshStockBar,
  } = useHomeDashboardState();

  const clearDuplicateBannerTimer = useCallback(() => {
    if (duplicateBannerTimer.current !== null) {
      window.clearTimeout(duplicateBannerTimer.current);
      duplicateBannerTimer.current = null;
    }
  }, []);

  const dismissDuplicateBanner = useCallback(() => {
    clearDuplicateBannerTimer();
    setDuplicateBannerVisible(false);
  }, [clearDuplicateBannerTimer]);

  useEffect(() => {
    if (!duplicateError) {
      clearDuplicateBannerTimer();
      setDuplicateBannerVisible(false);
      return undefined;
    }

    setDuplicateBannerVisible(true);
    clearDuplicateBannerTimer();
    duplicateBannerTimer.current = window.setTimeout(() => {
      duplicateBannerTimer.current = null;
      setDuplicateBannerVisible(false);
    }, DUPLICATE_BANNER_AUTO_DISMISS_MS);

    return clearDuplicateBannerTimer;
  }, [clearDuplicateBannerTimer, duplicateError]);

  useEffect(() => {
    if (taskPanelPreferenceSettledRef.current || activeTasks.length === 0) {
      return;
    }
    const nextCollapsed = activeTasks.length > 1;
    setIsTaskPanelCollapsed(nextCollapsed);
    writeTaskPanelCollapsedPreference(nextCollapsed);
    taskPanelPreferenceSettledRef.current = true;
  }, [activeTasks.length]);

  const handleTaskPanelCollapsedChange = useCallback((collapsed: boolean) => {
    setIsTaskPanelCollapsed(collapsed);
    taskPanelPreferenceSettledRef.current = true;
    writeTaskPanelCollapsedPreference(collapsed);
  }, []);

  useEffect(() => {
    document.title = 'StockMaster · 自选股';
  }, [t]);

  useEffect(() => {
    suppressLiveMarketRefreshRef.current = (
      isSubmittingMarketReview
      || Boolean(marketReviewReport)
      || isBatchAnalyzingWatchlist
    );
  }, [isBatchAnalyzingWatchlist, isSubmittingMarketReview, marketReviewReport]);

  const refreshLiveMarketDashboard = useCallback((): Promise<void> => {
    if (marketSnapshotRefreshPromiseRef.current) {
      return marketSnapshotRefreshPromiseRef.current;
    }
    const request = analysisApi.getMarketSnapshot('cn')
      .then((result) => {
        if (result.payload) {
          setMarketReviewPayload(result.payload);
          marketSnapshotRefreshedAtRef.current = Date.now();
        }
      })
      .catch(() => {
        // Keep the most recent persisted/review snapshot when live market data
        // is temporarily unavailable. This refresh never blocks the dashboard.
      })
      .finally(() => {
        marketSnapshotRefreshPromiseRef.current = null;
      });
    marketSnapshotRefreshPromiseRef.current = request;
    return request;
  }, []);

  useEffect(() => {
    const initialRefreshTimer = window.setTimeout(() => {
      void refreshLiveMarketDashboard();
    }, 0);

    const refreshIfActive = () => {
      if (!suppressLiveMarketRefreshRef.current && isDashboardWindowActive()) {
        void refreshLiveMarketDashboard();
      }
    };
    const refreshIfStale = () => {
      if (
        !suppressLiveMarketRefreshRef.current
        && isDashboardWindowActive()
        && Date.now() - marketSnapshotRefreshedAtRef.current >= MARKET_DASHBOARD_REFRESH_INTERVAL_MS
      ) {
        void refreshLiveMarketDashboard();
      }
    };
    const timer = window.setInterval(refreshIfActive, MARKET_DASHBOARD_REFRESH_INTERVAL_MS);
    window.addEventListener('focus', refreshIfStale);
    document.addEventListener('visibilitychange', refreshIfStale);

    return () => {
      window.clearTimeout(initialRefreshTimer);
      window.clearInterval(timer);
      window.removeEventListener('focus', refreshIfStale);
      document.removeEventListener('visibilitychange', refreshIfStale);
    };
  }, [refreshLiveMarketDashboard]);

  useEffect(() => {
    if (marketReviewPayload || marketReviewReport || isSubmittingMarketReview) {
      return undefined;
    }

    let active = true;
    const hydrateLatestMarketSnapshot = async () => {
      try {
        const response = await historyApi.getList({
          stockCode: 'MARKET',
          reportType: 'market_review',
          page: 1,
          limit: 1,
        });
        const latest = response.items.find((item) => (
          item.stockCode === 'MARKET' && item.reportType === 'market_review'
        ));
        if (!latest || !active) return;

        const report = await historyApi.getDetail(latest.id);
        const payload = report.details?.contextSnapshot?.marketReviewPayload;
        if (active && payload) {
          setMarketReviewPayload((current) => current ?? payload);
        }
      } catch {
        // The market snapshot is optional. Keep the dashboard available and
        // retry while the desktop startup prewarm is still running.
      }
    };

    void hydrateLatestMarketSnapshot();
    const timer = window.setInterval(() => {
      void hydrateLatestMarketSnapshot();
    }, 30_000);

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [isSubmittingMarketReview, marketReviewPayload, marketReviewReport]);

  useEffect(() => {
    let active = true;
    systemConfigApi.getSetupStatus()
      .then((status) => {
        if (active) {
          setSetupStatus(status);
        }
      })
      .catch(() => {
        if (active) {
          setSetupStatus(null);
        }
      });

    return () => {
      active = false;
    };
  }, []);

  const reportLanguage = normalizeReportLanguage(selectedReport?.meta.reportLanguage);
  const liveMarketReviewLanguage = normalizeReportLanguage(marketReviewPayload?.language);
  const isMarketReviewHistoryReport = selectedReport?.meta.reportType === 'market_review';
  const isHistoryTrendUnavailable = !selectedReport || !selectedReport.meta.stockCode;

  useEffect(() => {
    if (!isHistoryTrendUnavailable || !isHistoryTrendOpen) {
      return;
    }
    closeHistoryTrend();
  }, [closeHistoryTrend, isHistoryTrendOpen, isHistoryTrendUnavailable]);

  const setupNeedsAction = setupStatus ? !setupStatus.isComplete : false;
  const setupMissingLabels = useMemo(() => {
    if (!setupStatus) {
      return '';
    }
    const requiredNeedsAction = setupStatus.checks
      .filter((check) => check.required && check.status === 'needs_action')
      .map((check) => check.title);
    return requiredNeedsAction.slice(0, 3).join(uiLanguage === 'en' ? ', ' : '、');
  }, [setupStatus, uiLanguage]);

  const handleCompletedTaskDataRefreshStarted = useCallback((task: TaskInfo) => {
    if (task.reportType === 'market_review') {
      return;
    }
    const key = getStockCodeKey(task.stockCode);
    if (!key) {
      return;
    }
    setCompletedTaskRefreshPendingCounts((current) => {
      const next = new Map(current);
      next.set(key, (next.get(key) ?? 0) + 1);
      return next;
    });
  }, []);

  const handleCompletedTaskDataRefreshed = useCallback((task: TaskInfo) => {
    if (task.reportType === 'market_review') {
      return;
    }
    const key = getStockCodeKey(task.stockCode);
    if (key) {
      setCompletedTaskRefreshPendingCounts((current) => {
        const pendingCount = current.get(key) ?? 0;
        if (pendingCount === 0) {
          return current;
        }
        const next = new Map(current);
        if (pendingCount === 1) {
          next.delete(key);
        } else {
          next.set(key, pendingCount - 1);
        }
        return next;
      });
    }
    setTodayAnalysisRefreshVersion((version) => version + 1);
  }, []);

  const handleDashboardDataRefresh = useCallback(() => {
    setTodayAnalysisRefreshVersion((version) => version + 1);
  }, []);

  useDashboardLifecycle({
    loadInitialHistory,
    refreshHistory,
    refreshHistoryForCompletedTask,
    loadMarketReviewHistory,
    refreshMarketReviewHistory,
    loadStockBar,
    refreshStockBar,
    syncTaskCreated,
    syncTaskUpdated,
    syncTaskFailed,
    refreshActiveTasks,
    removeTask,
    onDashboardDataRefresh: handleDashboardDataRefresh,
    onCompletedTaskDataRefreshStarted: handleCompletedTaskDataRefreshStarted,
    onCompletedTaskDataRefreshed: handleCompletedTaskDataRefreshed,
  });

  useEffect(() => {
    if (isLoadingStockBar) {
      stockBarLoadStartedRef.current = true;
      return;
    }
    if (stockBarLoadStartedRef.current || stockBarItems.length > 0) {
      setIsStockBarInitialLoadSettled(true);
    }
  }, [isLoadingStockBar, stockBarItems.length]);

  const watchlistState = useWatchlist();
  const refreshWatchlist = watchlistState.refresh;
  const watchlistQuoteCodes = useMemo(
    () => watchlistState.watchlistCodes.filter((code) => getStockCodeKey(code) !== 'MARKET'),
    [watchlistState.watchlistCodes],
  );
  const refreshWatchlistQuotes = useCallback((): Promise<void> => {
    if (watchlistQuoteRefreshPromiseRef.current) {
      return watchlistQuoteRefreshPromiseRef.current;
    }
    if (watchlistQuoteCodes.length === 0) {
      setWatchlistQuotesByCode(new Map());
      return Promise.resolve();
    }

    const request = stocksApi.getQuotes(watchlistQuoteCodes)
      .then((response) => {
        const allowedKeys = new Set(watchlistQuoteCodes.map(getStockCodeKey).filter(Boolean));
        setWatchlistQuotesByCode((current) => {
          const next = new Map<string, StockQuote>();
          current.forEach((quote, key) => {
            if (allowedKeys.has(key)) next.set(key, quote);
          });
          response.items.forEach((quote) => {
            const key = getStockCodeKey(quote.stockCode);
            if (key && allowedKeys.has(key)) next.set(key, quote);
          });
          response.failedCodes.forEach((code) => {
            const key = getStockCodeKey(code);
            const previous = key ? next.get(key) : undefined;
            if (!key || !previous || previous.isStale) return;
            next.set(key, {
              ...previous,
              isStale: true,
              refreshStatus: 'failed',
              failureCount: (previous.failureCount || 0) + 1,
            });
          });
          return next;
        });
      })
      .catch(() => {
        // Reuse the last successful quote on a transient provider failure.
      })
      .finally(() => {
        watchlistQuoteRefreshPromiseRef.current = null;
      });
    watchlistQuoteRefreshPromiseRef.current = request;
    return request;
  }, [watchlistQuoteCodes]);

  const quoteRefreshState = useAshareQuoteRefresh({
    refresh: refreshWatchlistQuotes,
    refreshKey: watchlistQuoteCodes.map(getStockCodeKey).filter(Boolean).join(','),
    isBatchAnalyzing: isBatchAnalyzingWatchlist,
  });

  const watchlistCodesByNormalized = useMemo(() => {
    const codesByNormalized = new Map<string, string>();
    for (const code of watchlistState.watchlistCodes) {
      const key = getStockCodeKey(code);
      if (!key || key === 'MARKET' || codesByNormalized.has(key)) {
        continue;
      }
      codesByNormalized.set(key, code);
    }
    return Array.from(codesByNormalized.entries());
  }, [watchlistState.watchlistCodes]);

  const stockBarItemByCode = useMemo(() => {
    const itemsByCode = new Map<string, StockBarItem>();
    for (const item of stockBarItems) {
      if (item.stockCode === 'MARKET') {
        continue;
      }
      const key = getStockCodeKey(item.stockCode);
      if (key) {
        itemsByCode.set(key, item);
      }
    }
    return itemsByCode;
  }, [stockBarItems]);

  const canLookupWatchlistHistory = !isLoadingStockBar && isStockBarInitialLoadSettled;

  const watchlistMissingHistoryEntries = useMemo(
    () => (
      canLookupWatchlistHistory
        ? watchlistCodesByNormalized.filter(([key]) => !stockBarItemByCode.has(key))
        : []
    ),
    [canLookupWatchlistHistory, stockBarItemByCode, watchlistCodesByNormalized],
  );

  const watchlistMissingHistorySignature = useMemo(
    () => watchlistMissingHistoryEntries.map(([key]) => key).join('\n'),
    [watchlistMissingHistoryEntries],
  );

  useEffect(() => {
    if (!canLookupWatchlistHistory) {
      setWatchlistHistoryItemsByCode(new Map());
      setWatchlistHistoryLookupState({ signature: '', settledKeys: new Set(), failedKeys: new Set() });
      return undefined;
    }

    const missingCodes = watchlistMissingHistoryEntries.map(([, code]) => code);
    const missingKeys = watchlistMissingHistoryEntries.map(([key]) => key);
    const currentSignature = watchlistMissingHistorySignature;

    if (missingCodes.length === 0) {
      setWatchlistHistoryItemsByCode(new Map());
      setWatchlistHistoryLookupState({ signature: '', settledKeys: new Set(), failedKeys: new Set() });
      return;
    }

    let isCanceled = false;
    const abortController = new AbortController();
    setWatchlistHistoryLookupState({ signature: currentSignature, settledKeys: new Set(), failedKeys: new Set() });
    void (async () => {
      try {
        const results = await lookupWatchlistHistory(
          missingCodes,
          () => isCanceled,
          abortController.signal,
        );

        if (isCanceled) {
          return;
        }

        const next = new Map<string, StockBarItem>();
        const failedKeys = new Set<string>();
        for (const entry of results) {
          const key = getStockCodeKey(entry.code);
          if (!key) {
            continue;
          }
          if (entry.failed) {
            failedKeys.add(key);
            continue;
          }
          if (entry.item) {
            next.set(key, toStockBarItemFromHistoryItem(entry.item));
          }
        }
        setWatchlistHistoryItemsByCode(next);
        setWatchlistHistoryLookupState({
          signature: currentSignature,
          settledKeys: new Set(missingKeys),
          failedKeys,
        });
      } catch {
        if (!isCanceled) {
          setWatchlistHistoryItemsByCode(new Map());
          setWatchlistHistoryLookupState({
            signature: currentSignature,
            settledKeys: new Set(missingKeys),
            failedKeys: new Set(missingKeys),
          });
        }
      }
    })();

    return () => {
      isCanceled = true;
      abortController.abort();
    };
  }, [canLookupWatchlistHistory, watchlistHistoryRetryVersion, watchlistMissingHistoryEntries, watchlistMissingHistorySignature]);

  const clearMarketReviewState = useCallback(() => {
    stopMarketReviewPolling();
    setMarketReviewReport(null);
    setMarketReviewNotice(null);
    setMarketReviewError(null);
  }, [stopMarketReviewPolling]);

  const handleHistoryItemClick = useCallback((recordId: number) => {
    clearMarketReviewState();
    setIsDetailViewOpen(true);
    void selectHistoryItem(recordId);
  }, [clearMarketReviewState, selectHistoryItem]);

  const handleRefreshWatchlist = useCallback(async () => {
    await Promise.all([
      refreshWatchlist(),
      refreshStockBar(),
      refreshWatchlistQuotes(),
    ]);
    setWatchlistHistoryRetryVersion((version) => version + 1);
  }, [refreshStockBar, refreshWatchlist, refreshWatchlistQuotes]);

  const [isDeletingStock, setIsDeletingStock] = useState(false);
  const handleDeleteStock = useCallback(async (stockCode: string) => {
    if (isDeletingStock) return;
    setIsDeletingStock(true);
    try {
      await historyApi.deleteByCode(stockCode);
      await refreshStockBar();
      await refreshHistory(true);
      if (stockCode === 'MARKET') {
        await refreshMarketReviewHistory(false);
      }
    } catch {
      // error silently ignored
    } finally {
      setIsDeletingStock(false);
    }
  }, [isDeletingStock, refreshMarketReviewHistory, refreshStockBar, refreshHistory]);

  const handleSubmitAnalysis = useCallback(
    (
      stockCode?: string,
      stockName?: string,
      selectionSource?: 'manual' | 'autocomplete' | 'import' | 'image',
      analysisSkills?: string[],
    ) => {
      void submitAnalysis({
        stockCode,
        stockName,
        originalQuery: query,
        selectionSource: selectionSource ?? 'manual',
        skills: analysisSkills,
        forceRefresh: true,
      });
    },
    [query, submitAnalysis],
  );

  useEffect(() => {
    const state = location.state as StockAnalysisNavigationState | null;
    const stockCode = typeof state?.stockCode === 'string' ? state.stockCode.trim() : '';
    if (!stockCode) {
      return;
    }
    const stockName = typeof state?.stockName === 'string' ? state.stockName.trim() : '';
    setQuery(stockCode);
    navigate(location.pathname, { replace: true, state: null });
    if (state?.autoAnalyze) {
      handleSubmitAnalysis(stockCode, stockName || undefined, 'import', state.skills);
    }
  }, [handleSubmitAnalysis, location.pathname, location.state, navigate, setQuery]);

  const handleAskFollowUp = useCallback(() => {
    if (selectedReport?.meta.id === undefined || selectedReport.meta.reportType === 'market_review') {
      return;
    }
    const panel = document.querySelector<HTMLElement>('[data-testid="report-chat-panel"]');
    if (panel && typeof panel.scrollIntoView === 'function') {
      panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    panel?.querySelector<HTMLInputElement>('input')?.focus();
  }, [selectedReport]);

  const handleReanalyze = useCallback(() => {
    if (!selectedReport || selectedReport.meta.reportType === 'market_review') {
      return;
    }

    void submitAnalysis({
      stockCode: selectedReport.meta.stockCode,
      stockName: selectedReport.meta.stockName,
      originalQuery: selectedReport.meta.stockCode,
      selectionSource: 'manual',
      forceRefresh: true,
    });
  }, [selectedReport, submitAnalysis]);

  const openTaskRunFlow = useCallback((task: TaskInfo) => {
    const stock = task.stockName || task.stockCode || task.taskId;
    setRunFlowDrawer({
      open: true,
      source: { type: 'task', taskId: task.taskId },
      title: t('runFlow.taskDrawerTitle', { stock }),
    });
  }, [t]);

  const openHistoryRunFlow = useCallback((recordId: number) => {
    const meta = selectedReport?.meta.id === recordId ? selectedReport.meta : null;
    const stock = meta?.stockName || meta?.stockCode || String(recordId);
    setRunFlowDrawer({
      open: true,
      source: { type: 'history', recordId },
      title: t('runFlow.historyDrawerTitle', { stock }),
    });
  }, [selectedReport, t]);

  const closeRunFlowDrawer = useCallback(() => {
    setRunFlowDrawer({ open: false });
  }, []);

  const pollMarketReviewStatus = useCallback(
    async (taskId: string) => {
      stopMarketReviewPolling();

      const maxAttempts = 120;
      const intervalMs = 2000;
      let attempts = 0;

      const poll = async (): Promise<boolean> => {
        if (attempts >= maxAttempts) {
          stopMarketReviewPolling();
          setMarketReviewReport(null);
          setMarketReviewNotice({
            variant: 'danger',
            title: t('home.marketReviewTimeout'),
            message: t('home.marketReviewTimeoutMessage'),
          });
          scrollMarketReviewFeedbackIntoView();
          return false;
        }

        attempts += 1;

        try {
          const status = await analysisApi.getStatus(taskId);
          if (status.status === 'pending' || status.status === 'processing') {
            setMarketReviewReport(null);
            const progress = typeof status.progress === 'number'
              ? `${status.progress}%`
              : t('home.progressActive');
            setMarketReviewNotice({
              variant: 'warning',
              title: t('home.marketReviewInProgress'),
              message: status.region
                ? t('home.taskStatusWithRegion', { status: status.status, progress, region: status.region })
                : t('home.taskStatus', { status: status.status, progress }),
            });
            return true;
          }

          if (status.status === 'completed') {
            stopMarketReviewPolling();
            const marketReviewText = typeof status.marketReviewReport === 'string'
              ? status.marketReviewReport
              : '';
            setMarketReviewReport(marketReviewText ? marketReviewText.trim() : null);
            if (status.marketReviewPayload) {
              setMarketReviewPayload(status.marketReviewPayload);
              marketSnapshotRefreshedAtRef.current = Date.now();
            }
            setMarketReviewNotice({
              variant: 'success',
              title: t('home.marketReviewCompleted'),
              message: marketReviewText ? t('home.marketReviewCompletedWithReport') : t('home.marketReviewCompletedWithoutReport'),
            });
            setMarketReviewError(null);
            await refreshMarketReviewHistory(true);
            scrollMarketReviewFeedbackIntoView();
            return false;
          }

          if (status.status === 'failed') {
            stopMarketReviewPolling();
            setMarketReviewReport(null);
            setMarketReviewError(
              getParsedApiError({
                response: {
                  status: 500,
                  data: {
                    error: 'market_review_failed',
                    message: status.error || t('home.marketReviewFailed'),
                  },
                },
              }),
            );
            setMarketReviewNotice(null);
            scrollMarketReviewFeedbackIntoView();
            return false;
          }

          stopMarketReviewPolling();
          setMarketReviewReport(null);
          setMarketReviewNotice({
            variant: 'danger',
            title: t('home.marketReviewUnknownStatus'),
            message: t('home.unknownTaskStatus', { status: status.status }),
          });
          scrollMarketReviewFeedbackIntoView();
          return false;
        } catch (err: unknown) {
          const parsed = getParsedApiError(err);
          if (attempts >= maxAttempts) {
            stopMarketReviewPolling();
            setMarketReviewReport(null);
            setMarketReviewError(parsed);
            setMarketReviewNotice(null);
            scrollMarketReviewFeedbackIntoView();
            return false;
          }
          return true;
        }

        return true;
      };

      if (await poll()) {
        marketReviewPollTimer.current = window.setInterval(() => {
          void poll().then((shouldContinue) => {
            if (!shouldContinue) {
              stopMarketReviewPolling();
            }
          });
        }, intervalMs);
      }
    },
    [refreshMarketReviewHistory, scrollMarketReviewFeedbackIntoView, stopMarketReviewPolling, t],
  );

  const handleTriggerMarketReview = useCallback(async () => {
    setIsSubmittingMarketReview(true);
    setMarketReviewNotice(null);
    setMarketReviewError(null);
    setMarketReviewReport(null);
    scrollMarketReviewFeedbackIntoView();
    try {
      const result = await analysisApi.triggerMarketReview({
        sendNotification: notify,
        regions: marketReviewRegionOverride,
      });
      setMarketReviewNotice({
        variant: 'success',
        title: t('home.marketReviewSubmitted'),
        message: t('home.marketReviewSubmittedWithRegion', {
          message: result.message,
          region: result.region,
        }),
      });
      scrollMarketReviewFeedbackIntoView();

      if (result.taskId) {
        await pollMarketReviewStatus(result.taskId);
      }
    } catch (err: unknown) {
      setMarketReviewError(getParsedApiError(err));
      setMarketReviewNotice(null);
      scrollMarketReviewFeedbackIntoView();
    } finally {
      setIsSubmittingMarketReview(false);
    }
  }, [marketReviewRegionOverride, notify, pollMarketReviewStatus, scrollMarketReviewFeedbackIntoView, t]);

  const todayDateKey = getTodayInShanghai();
  useEffect(() => {
    if (sidebarWorkspaceTab !== 'today') {
      return undefined;
    }

    let active = true;
    setIsLoadingTodayAnalysisItems(true);
    setTodayAnalysisLoadFailed(false);
    void getTodayAnalysisItems(todayDateKey)
      .then((items) => {
        if (active) {
          setTodayHistoryItems(items);
          setTodayAnalysisLoadFailed(false);
        }
      })
      .catch(() => {
        if (active) {
          setTodayHistoryItems([]);
          setTodayAnalysisLoadFailed(true);
        }
      })
      .finally(() => {
        if (active) {
          setIsLoadingTodayAnalysisItems(false);
        }
      });

    return () => {
      active = false;
    };
  }, [sidebarWorkspaceTab, todayAnalysisRefreshVersion, todayDateKey]);

  const activeTaskByCode = useMemo(() => {
    const tasksByCode = new Map<string, TaskInfo>();
    for (const task of activeTasks) {
      if (!['pending', 'processing', 'cancel_requested'].includes(task.status)) {
        continue;
      }
      if (task.reportType === 'market_review') {
        continue;
      }
      const key = getStockCodeKey(task.stockCode);
      if (key) {
        tasksByCode.set(key, task);
      }
    }
    return tasksByCode;
  }, [activeTasks]);

  const watchlistRows = useMemo<HomeWatchlistRow[]>(() => (
    watchlistState.watchlistCodes.map((code) => {
      const key = getStockCodeKey(code);
      const latestItemCandidate = key
        ? stockBarItemByCode.get(key) ?? watchlistHistoryItemsByCode.get(key)
        : undefined;
      const isMissingFromStockBar = Boolean(key && !stockBarItemByCode.has(key));
      const hasPendingHistoryLookup = Boolean(
        isMissingFromStockBar
        && (
          !canLookupWatchlistHistory
          ||
          watchlistHistoryLookupState.signature !== watchlistMissingHistorySignature
          || !watchlistHistoryLookupState.settledKeys.has(key)
        ),
      );
      const hasFailedHistoryLookup = Boolean(
        isMissingFromStockBar
        && canLookupWatchlistHistory
        && watchlistHistoryLookupState.signature === watchlistMissingHistorySignature
        && watchlistHistoryLookupState.failedKeys.has(key)
      );
      const isTodayStatusLoading = Boolean(
        isLoadingStockBar
        || hasPendingHistoryLookup
        || (key && completedTaskRefreshPendingCounts.has(key))
      );
      const isTodayStatusUnknown = Boolean(
        hasFailedHistoryLookup
        || (stockBarRefreshFailed && !hasPendingHistoryLookup)
      );
      const latestItem = isTodayStatusLoading || isTodayStatusUnknown
        ? undefined
        : latestItemCandidate;
      return {
        code,
        latestItem,
        quote: key ? watchlistQuotesByCode.get(key) : undefined,
        analyzedToday: !isTodayStatusLoading && !isTodayStatusUnknown && getShanghaiDateKey(latestItem?.lastAnalysisTime) === todayDateKey,
        isTodayStatusLoading,
        isTodayStatusUnknown,
        activeTask: key ? activeTaskByCode.get(key) : undefined,
        isHeld: Boolean(key && heldStockKeys.has(key)),
      };
    })
  ), [
    activeTaskByCode,
    canLookupWatchlistHistory,
    completedTaskRefreshPendingCounts,
    isLoadingStockBar,
    stockBarRefreshFailed,
    stockBarItemByCode,
    heldStockKeys,
    todayDateKey,
    watchlistQuotesByCode,
    watchlistHistoryItemsByCode,
    watchlistHistoryLookupState,
    watchlistMissingHistorySignature,
    watchlistState.watchlistCodes,
  ]);

  const pendingWatchlistCodes = useMemo(
    () => watchlistRows
      .filter((row) => !row.analyzedToday && !row.isTodayStatusLoading && !row.isTodayStatusUnknown)
      .map((row) => row.code),
    [watchlistRows],
  );

  const watchlistTodayStatusBlocked = useMemo(
    () => watchlistRows.some((row) => row.isTodayStatusLoading || row.isTodayStatusUnknown),
    [watchlistRows],
  );

  const todayAnalysisItems = useMemo(() => {
    const itemsById = new Map<number, StockBarItem>();
    const addItem = (item: StockBarItem) => {
      if (item.stockCode === 'MARKET' || item.reportType === 'market_review') {
        return;
      }
      if (getShanghaiDateKey(item.lastAnalysisTime) !== todayDateKey) {
        return;
      }
      itemsById.set(item.id, item);
    };

    for (const item of todayHistoryItems) {
      addItem(item);
    }

    return Array.from(itemsById.values())
      .sort((left, right) => {
        const leftScore = typeof left.sentimentScore === 'number' ? left.sentimentScore : -1;
        const rightScore = typeof right.sentimentScore === 'number' ? right.sentimentScore : -1;
        if (rightScore !== leftScore) {
          return rightScore - leftScore;
        }
        const leftTime = getShanghaiTimeValue(left.lastAnalysisTime);
        const rightTime = getShanghaiTimeValue(right.lastAnalysisTime);
        return rightTime - leftTime;
      });
  }, [todayDateKey, todayHistoryItems]);

  const handleStopBatchAnalysis = useCallback(() => {
    if (!isBatchAnalyzingWatchlist || batchStopRequestedRef.current) {
      return;
    }
    batchStopRequestedRef.current = true;
    setIsBatchStopRequested(true);
    setBatchAnalyzeStatus({
      variant: 'warning',
      message: t('watchlist.batchStopping'),
    });
  }, [isBatchAnalyzingWatchlist, t]);

  const handleAnalyzeWatchlist = useCallback(async (mode: WatchlistAnalyzeMode, selectedCodes: string[] = []) => {
    if (mode === 'pending' && watchlistTodayStatusBlocked) {
      setBatchAnalyzeStatus({
        variant: 'warning',
        message: t('watchlist.pendingStatusUnavailable'),
      });
      return;
    }

    const sourceCodes = mode === 'pending'
      ? pendingWatchlistCodes
      : mode === 'selected'
        ? selectedCodes
        : watchlistState.watchlistCodes;
    const seen = new Set<string>();
    const targetCodes = sourceCodes.filter((code) => {
      const key = getStockCodeKey(code);
      if (!key || seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });

    if (targetCodes.length === 0) {
      setBatchAnalyzeStatus({
        variant: 'warning',
        message: mode === 'pending'
          ? t('watchlist.noPendingAnalyze')
          : mode === 'selected'
            ? t('watchlist.noSelectedAnalyze')
            : t('watchlist.noStocksAnalyze'),
      });
      return;
    }

    setIsBatchAnalyzingWatchlist(true);
    batchStopRequestedRef.current = false;
    setIsBatchStopRequested(false);
    setBatchAnalyzeStatus(null);
    window.localStorage.setItem(WATCHLIST_BATCH_RECOVERY_STORAGE_KEY, JSON.stringify({ stockCodes: targetCodes }));
    const unsettledCodes = new Set(targetCodes.map((code) => getStockCodeKey(code)));
    let acceptedCount = 0;
    let duplicateCount = 0;
    try {
      const result = await runWatchlistBatchAnalysis({
        stockCodes: targetCodes,
        submit: async (stockCode) => {
          try {
            return await analysisApi.analyzeAsync({
              stockCode,
              reportType: 'detailed',
              notify,
              forceRefresh: true,
            });
          } catch (error) {
            if (!(error instanceof DuplicateTaskError)) {
              throw error;
            }
            return {
              accepted: [],
              duplicates: [{
                stockCode: error.stockCode,
                existingTaskId: error.existingTaskId,
                message: error.message,
              }],
              message: error.message,
            };
          }
        },
        waitForTask: (taskId) => waitForWatchlistTask(taskId, analysisApi.getStatus),
        shouldStop: () => batchStopRequestedRef.current,
        maxConcurrency: WATCHLIST_ANALYSIS_CONCURRENCY,
        onStockSubmitted: ({ acceptedCount: nextAcceptedCount, duplicateCount: nextDuplicateCount }) => {
          acceptedCount = nextAcceptedCount;
          duplicateCount = nextDuplicateCount;
        },
        onStockSettled: (stockCode) => {
          unsettledCodes.delete(getStockCodeKey(stockCode));
          const remaining = targetCodes.filter((code) => unsettledCodes.has(getStockCodeKey(code)));
          window.localStorage.setItem(WATCHLIST_BATCH_RECOVERY_STORAGE_KEY, JSON.stringify({ stockCodes: remaining }));
        },
      });
      acceptedCount = result.acceptedCount;
      duplicateCount = result.duplicateCount;

      // Reconcile even after a failed request: a timeout or disconnect may occur
      // after the server has accepted a task, and the current stock may still be running.
      await refreshActiveTasks();
      setSidebarWorkspaceTab('watchlist');

      if (result.stopped) {
        setBatchAnalyzeStatus({
          variant: 'warning',
          message: t('watchlist.batchStopped', {
            processed: result.processedCount,
            accepted: acceptedCount,
            duplicates: duplicateCount,
          }),
        });
        return;
      }

      setBatchAnalyzeStatus({
        variant: result.failedCount > 0 ? 'warning' : acceptedCount > 0 ? 'success' : 'warning',
        message: result.failedCount > 0
          ? t('watchlist.batchSubmittedWithFailure', {
              accepted: acceptedCount,
              failed: result.failedCount,
              error: result.failureReason || t('watchlist.batchFailed'),
            })
          : t('watchlist.batchSubmitted', {
              accepted: acceptedCount,
              duplicates: duplicateCount,
              failed: result.failedCount,
            }),
      });
    } catch (error: unknown) {
      try {
        await refreshActiveTasks();
        setSidebarWorkspaceTab('watchlist');
      } catch {
        // Preserve the original submission error if reconciliation is unavailable.
      }
      const parsed = getParsedApiError(error);
      if (acceptedCount > 0 || duplicateCount > 0) {
        setBatchAnalyzeStatus({
          variant: 'warning',
          message: t('watchlist.batchPartiallySubmitted', {
            accepted: acceptedCount,
            duplicates: duplicateCount,
            unconfirmed: targetCodes.length - acceptedCount - duplicateCount,
            error: parsed.message || t('watchlist.batchFailed'),
          }),
        });
      } else {
        setBatchAnalyzeStatus({
          variant: 'danger',
          message: parsed.message || t('watchlist.batchFailed'),
        });
      }
    } finally {
      setIsBatchAnalyzingWatchlist(false);
      setIsBatchStopRequested(false);
      batchStopRequestedRef.current = false;
      window.localStorage.removeItem(WATCHLIST_BATCH_RECOVERY_STORAGE_KEY);
    }
  }, [
    notify,
    pendingWatchlistCodes,
    refreshActiveTasks,
    t,
    watchlistTodayStatusBlocked,
    watchlistState.watchlistCodes,
  ]);

  const handleTerminalCommand = useCallback((
    value: string,
    stockName?: string,
    source?: 'manual' | 'autocomplete',
  ) => {
    const command = value.trim();
    if (!command) return;
    if (command.toLowerCase() === ':review') {
      void handleTriggerMarketReview();
      return;
    }
    if (command.toLowerCase() === ':batch') {
      void handleAnalyzeWatchlist('all');
      return;
    }
    handleSubmitAnalysis(command, stockName, source);
  }, [handleAnalyzeWatchlist, handleSubmitAnalysis, handleTriggerMarketReview]);

  useEffect(() => {
    if (batchRecoveryStartedRef.current || isBatchAnalyzingWatchlist) return;
    batchRecoveryStartedRef.current = true;
    try {
      const raw = window.localStorage.getItem(WATCHLIST_BATCH_RECOVERY_STORAGE_KEY);
      if (!raw) return;
      const payload = JSON.parse(raw) as { stockCodes?: unknown };
      const stockCodes = Array.isArray(payload.stockCodes)
        ? payload.stockCodes.filter((code): code is string => typeof code === 'string' && Boolean(code.trim()))
        : [];
      if (stockCodes.length === 0) {
        window.localStorage.removeItem(WATCHLIST_BATCH_RECOVERY_STORAGE_KEY);
        return;
      }
      setBatchAnalyzeStatus({ variant: 'warning', message: t('watchlist.batchRestoring', { count: stockCodes.length }) });
      void handleAnalyzeWatchlist('selected', stockCodes);
    } catch {
      window.localStorage.removeItem(WATCHLIST_BATCH_RECOVERY_STORAGE_KEY);
    }
  }, [handleAnalyzeWatchlist, isBatchAnalyzingWatchlist, t]);

  const mergedStockBarItems = useMemo<StockBarItem[]>(() => {
    const latestMarketReview = marketReviewHistoryItems[0];
    const stockItems = stockBarItems.filter((item) => item.stockCode !== 'MARKET');
    if (
      selectedReport?.meta.id !== undefined
      && selectedReport.meta.reportType !== 'market_review'
      && !stockItems.some((item) => item.id === selectedReport.meta.id)
    ) {
      stockItems.push({
        id: selectedReport.meta.id,
        stockCode: selectedReport.meta.stockCode,
        stockName: selectedReport.meta.stockName,
        reportType: selectedReport.meta.reportType,
        sentimentScore: selectedReport.summary.sentimentScore,
        operationAdvice: selectedReport.summary.operationAdvice,
        analysisCount: 1,
        lastAnalysisTime: selectedReport.meta.createdAt,
        modelUsed: selectedReport.meta.modelUsed,
        marketPhaseSummary: selectedReport.meta.marketPhaseSummary,
      });
    }
    if (!latestMarketReview) {
      return stockItems;
    }

    const marketReviewItem: StockBarItem = {
      id: latestMarketReview.id,
      stockCode: 'MARKET',
      stockName: latestMarketReview.stockName || t('home.marketReview'),
      reportType: 'market_review',
      sentimentScore: latestMarketReview.sentimentScore,
      operationAdvice: latestMarketReview.operationAdvice,
      analysisCount: Math.max(marketReviewHistoryItems.length, 1),
      lastAnalysisTime: latestMarketReview.createdAt,
      modelUsed: latestMarketReview.modelUsed,
      marketPhaseSummary: latestMarketReview.marketPhaseSummary,
    };

    return [marketReviewItem, ...stockItems].sort((left, right) => {
      const leftTime = left.lastAnalysisTime ? Date.parse(left.lastAnalysisTime) : 0;
      const rightTime = right.lastAnalysisTime ? Date.parse(right.lastAnalysisTime) : 0;
      return rightTime - leftTime;
    });
  }, [marketReviewHistoryItems, selectedReport, stockBarItems, t]);

  const sidebarContent = useMemo(
    () => (
      <div className="stockmaster-side-content flex h-full min-h-0 flex-col gap-2 overflow-hidden">
        <HomeStockWorkspace
          activeTab={sidebarWorkspaceTab}
          onActiveTabChange={setSidebarWorkspaceTab}
          watchlistRows={watchlistRows}
          watchlistLoading={watchlistState.isLoading}
          watchlistActioning={watchlistState.isActioning}
          watchlistMessage={watchlistState.actionMessage}
          onAddToWatchlist={watchlistState.addToWatchlist}
          onRemoveFromWatchlist={watchlistState.removeFromWatchlist}
          onRefreshWatchlist={handleRefreshWatchlist}
          onAnalyzeWatchlist={handleAnalyzeWatchlist}
          onStopAnalyzeWatchlist={handleStopBatchAnalysis}
          isBatchAnalyzing={isBatchAnalyzingWatchlist}
          isBatchStopRequested={isBatchStopRequested}
          batchStatus={batchAnalyzeStatus}
          quoteRefreshState={quoteRefreshState}
          todayItems={todayAnalysisItems}
          isLoadingTodayItems={isLoadingTodayAnalysisItems}
          todayLoadError={todayAnalysisLoadFailed}
          historyItems={mergedStockBarItems}
          isLoadingHistory={isLoadingStockBar}
          selectedStockCode={selectedReport?.meta.stockCode}
          selectedRecordId={selectedReport?.meta.id}
          onHistoryItemClick={handleHistoryItemClick}
          onDeleteStock={handleDeleteStock}
          isDeleting={isDeletingStock}
          className="flex-1"
        />
        <TaskPanel
          tasks={activeTasks}
          onOpenRunFlow={openTaskRunFlow}
          collapsed={isTaskPanelCollapsed}
          onCollapsedChange={handleTaskPanelCollapsedChange}
        />
      </div>
    ),
    [
      activeTasks,
      batchAnalyzeStatus,
      quoteRefreshState,
      handleAnalyzeWatchlist,
      handleStopBatchAnalysis,
      handleDeleteStock,
      handleHistoryItemClick,
      handleRefreshWatchlist,
      handleTaskPanelCollapsedChange,
      isBatchAnalyzingWatchlist,
      isBatchStopRequested,
      isDeletingStock,
      isLoadingStockBar,
      isLoadingTodayAnalysisItems,
      isTaskPanelCollapsed,
      todayAnalysisLoadFailed,
      mergedStockBarItems,
      openTaskRunFlow,
      selectedReport?.meta.id,
      selectedReport?.meta.stockCode,
      sidebarWorkspaceTab,
      todayAnalysisItems,
      watchlistRows,
      watchlistState.actionMessage,
      watchlistState.addToWatchlist,
      watchlistState.isActioning,
      watchlistState.isLoading,
      watchlistState.removeFromWatchlist,
    ],
  );

  const marketDashboardPayload = marketReviewPayload?.markets?.cn ?? marketReviewPayload;
  const primaryIndex = marketDashboardPayload?.indices?.[0];
  const marketBreadth = marketDashboardPayload?.breadth;
  const analyzedTodayCount = watchlistRows.filter((row) => row.analyzedToday).length;
  const runningTaskCount = activeTasks.filter((task) => task.status === 'processing').length;
  const queuedTaskCount = activeTasks.filter((task) => task.status === 'pending').length;
  const degradedTaskCount = activeTasks.filter((task) => /degrad|fallback|降级/i.test(`${task.message || ''} ${task.error || ''}`)).length;
  const latestMarketReviewSummary = marketReviewHistoryItems[0]?.analysisSummary?.trim() || '';
  const hotSectors = marketDashboardPayload?.sectors?.top?.slice(0, 5) || [];
  const reportVisible = Boolean(marketReviewReport || (isDetailViewOpen && selectedReport));

  return (
    <div data-testid="home-dashboard" className="stockmaster-home terminal-home">
      <header className="terminal-ticker" data-testid="stockmaster-brand-banner">
        <div className="terminal-ticker-brand"><span>S</span><strong>StockMaster</strong><small>TERMINAL</small></div>
        {marketDashboardPayload?.indices?.slice(0, 3).map((index) => (
          <div className="terminal-ticker-item" key={index.code}>
            <span>{index.name}</span>
            <strong className="terminal-mono">{index.current?.toFixed(2) || '--'}</strong>
            <em className={`terminal-mono ${(index.changePct || 0) > 0 ? 'term-up' : (index.changePct || 0) < 0 ? 'term-down' : ''}`}>{typeof index.changePct === 'number' ? `${index.changePct > 0 ? '+' : ''}${index.changePct.toFixed(2)}%` : '--'}</em>
          </div>
        ))}
        <div className="terminal-ticker-status">
          <i className={degradedTaskCount > 0 ? 'is-degraded' : ''} />
          <span>{degradedTaskCount > 0 ? t('terminal.systemDegraded') : t('terminal.systemReady')}</span>
        </div>
      </header>

      <div className="terminal-command-bar">
        <span className="terminal-command-prompt terminal-mono">▸</span>
        <StockAutocomplete
          value={query}
          onChange={setQuery}
          onSubmit={handleTerminalCommand}
          disabled={isAnalyzing}
          placeholder={t('terminal.commandHint')}
          ariaLabel={t('terminal.commandHint')}
          className="terminal-command-input"
        />
        <div className="terminal-review-command">
          <MarketReviewRegionSelector
            value={marketReviewRegionOverride}
            disabled={isSubmittingMarketReview}
            onChange={setMarketReviewRegionOverride}
          />
          <button type="button" disabled={isSubmittingMarketReview} onClick={() => void handleTriggerMarketReview()}>
            {t('home.marketReview')}
          </button>
        </div>
        <button type="button" className={`terminal-notify-toggle ${notify ? 'is-active' : ''}`} onClick={() => setNotify(!notify)} aria-pressed={notify}>
          {notify ? <Bell className="h-4 w-4" aria-hidden="true" /> : <BellOff className="h-4 w-4" aria-hidden="true" />}
          <span>{t('home.notify')}</span>
        </button>
        <button type="button" className="terminal-primary-button" disabled={isAnalyzing || !query.trim()} onClick={() => handleTerminalCommand(query)}>
          {isAnalyzing ? t('home.analyzing') : t('home.analyze')}
        </button>
      </div>

      <div className="terminal-alert-stack">
        {inputError ? <InlineAlert variant="warning" title={t('home.inputInvalid')} message={inputError} /> : null}
        {!inputError && duplicateError && duplicateBannerVisible ? (
          <InlineAlert
            variant="warning"
            title={t('home.duplicateTask')}
            message={duplicateError}
            action={<button type="button" onClick={dismissDuplicateBanner} aria-label={t('common.close')}><X className="h-4 w-4" /></button>}
          />
        ) : null}
        {setupNeedsAction ? (
          <InlineAlert
            variant="warning"
            title={t('home.setupIncomplete')}
            message={setupMissingLabels ? t('home.setupMissingWithLabels', { labels: setupMissingLabels }) : t('home.setupMissingGeneric')}
            action={<Button type="button" variant="secondary" size="sm" onClick={() => navigate('/settings')}>{t('home.goSettings')}</Button>}
          />
        ) : null}
        {marketReviewNotice ? <InlineAlert variant={marketReviewNotice.variant} title={marketReviewNotice.title} message={marketReviewNotice.message} /> : null}
        {marketReviewError ? <ApiErrorAlert error={marketReviewError} onDismiss={() => setMarketReviewError(null)} /> : null}
        {error ? <ApiErrorAlert error={error} onDismiss={clearError} /> : null}
      </div>

      <section ref={dashboardScrollRef} data-testid="home-dashboard-scroll" className="terminal-stage">
        {reportVisible ? (
          <div className="terminal-detail-stage">
            <div className="terminal-detail-toolbar">
              <button
                type="button"
                className="terminal-back-button"
                onClick={() => {
                  setIsDetailViewOpen(false);
                  clearMarketReviewState();
                  closeHistoryTrend();
                }}
              >
                <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                {t('terminal.backToWatchlist')}
              </button>
              {selectedReport && !marketReviewReport ? (
                <div className="terminal-detail-actions">
                  {isMarketReviewHistoryReport
                    ? <Button variant="secondary" size="sm" disabled={isSubmittingMarketReview} onClick={() => void handleTriggerMarketReview()}>{t('home.rerunMarketReview')}</Button>
                    : <Button variant="secondary" size="sm" disabled={isAnalyzing || selectedReport.meta.id === undefined} onClick={handleReanalyze}>{t('home.reanalyze')}</Button>}
                  {!isMarketReviewHistoryReport ? <Button variant="secondary" size="sm" disabled={selectedReport.meta.id === undefined} onClick={handleAskFollowUp}>{t('home.askAi')}</Button> : null}
                  <Button variant="secondary" size="sm" disabled={selectedReport.meta.id === undefined || isHistoryTrendUnavailable} onClick={() => isHistoryTrendOpen ? closeHistoryTrend() : void openHistoryTrend()}>{t('home.historyTrend')}</Button>
                  <Button variant="secondary" size="sm" disabled={selectedReport.meta.id === undefined} onClick={openMarkdownDrawer}>{t('home.fullReport')}</Button>
                </div>
              ) : null}
            </div>
            <AnalysisStatusBar tasks={activeTasks} batchStatus={batchAnalyzeStatus} />
            {marketReviewReport ? (
              <MarketReviewReportView content={marketReviewReport} payload={marketReviewPayload} reportLanguage={liveMarketReviewLanguage} />
            ) : isLoadingReport ? (
              <DashboardStateBlock title={t('home.loadingReport')} loading />
            ) : selectedReport ? (
              <div className="terminal-report-content">
                {isHistoryTrendOpen ? (
                  <StockHistoryTrendDrawer
                    key={`stock-history-${selectedReport.meta.id}`}
                    report={selectedReport}
                    items={stockHistoryItems}
                    total={stockHistoryTotal}
                    hasMore={stockHistoryHasMore}
                    isLoading={isLoadingStockHistory}
                    isLoadingMore={isLoadingMoreStockHistory}
                    error={stockHistoryError}
                    filters={stockHistoryFilters}
                    onClose={closeHistoryTrend}
                    onRangeChange={(range) => void setStockHistoryRange(range)}
                    onLoadMore={() => void loadMoreStockHistory()}
                    onSelectRecord={(recordId) => void selectHistoryItem(recordId)}
                    onRetry={() => void openHistoryTrend()}
                  />
                ) : <ReportSummary data={selectedReport} isHistory onOpenRunFlow={openHistoryRunFlow} />}
                {!isMarketReviewHistoryReport ? <ReportChatPanel report={selectedReport} /> : null}
              </div>
            ) : (
              <EmptyState title={t('home.startAnalysisTitle')} description={t('home.startAnalysisDescription')} />
            )}
          </div>
        ) : (
          <div className="terminal-master-grid">
            <main className="terminal-master-main">
              <section className="terminal-pulse-strip">
                <div><span>{primaryIndex?.name || t('home.marketRegionCn')}</span><strong className={`terminal-mono ${(primaryIndex?.changePct || 0) > 0 ? 'term-up' : (primaryIndex?.changePct || 0) < 0 ? 'term-down' : ''}`}>{primaryIndex?.current?.toFixed(2) || '--'}</strong><small className="terminal-mono">{typeof primaryIndex?.changePct === 'number' ? `${primaryIndex.changePct > 0 ? '+' : ''}${primaryIndex.changePct.toFixed(2)}%` : t('common.noData')}</small></div>
                <div><span>{t('terminal.marketBreadth')}</span><strong className="terminal-mono"><em className="term-up">{marketBreadth?.upCount ?? '--'}</em><b>/</b><em className="term-down">{marketBreadth?.downCount ?? '--'}</em></strong><small>{t('terminal.upDownCount')}</small></div>
                <div><span>{t('terminal.completedToday')}</span><strong className="terminal-mono">{analyzedTodayCount}<b>/</b>{watchlistRows.length}</strong><small>{watchlistRows.length - analyzedTodayCount} {t('terminal.pendingCount')}</small></div>
                <div><span>{t('terminal.runningTasks')}</span><strong className="terminal-mono is-amber">{runningTaskCount}</strong><small>{queuedTaskCount} {t('taskPanel.pending')}</small></div>
              </section>
              <div className="terminal-workspace-stack">{sidebarContent}</div>
            </main>

            <aside className="terminal-market-context">
              <section>
                <header><h2>{t('terminal.marketContext')}</h2><span className="terminal-meta">CN</span></header>
                <div className="terminal-context-status">
                  <strong className={`terminal-mono ${marketBreadth ? ((marketBreadth.upCount || 0) - (marketBreadth.downCount || 0) >= 0 ? 'term-up' : 'term-down') : ''}`}>{marketBreadth ? (marketBreadth.upCount || 0) - (marketBreadth.downCount || 0) : '--'}</strong>
                  <span>{marketBreadth ? t('terminal.breadthDifference') : t('common.noData')}</span>
                </div>
              </section>
              <section>
                <header><h2>{t('terminal.marketReviewSummary')}</h2></header>
                <p>{latestMarketReviewSummary || t('terminal.noMarketReview')}</p>
                <button type="button" className="terminal-text-link" disabled={isSubmittingMarketReview} onClick={() => void handleTriggerMarketReview()}>{isSubmittingMarketReview ? t('home.submitMarketReview') : t('home.rerunMarketReview')}</button>
              </section>
              <section>
                <header><h2>{t('terminal.marketBreadth')}</h2></header>
                <dl className="terminal-data-list">
                  <div><dt>{t('terminal.rising')}</dt><dd className="terminal-mono term-up">{marketBreadth?.upCount ?? '--'}</dd></div>
                  <div><dt>{t('terminal.falling')}</dt><dd className="terminal-mono term-down">{marketBreadth?.downCount ?? '--'}</dd></div>
                  <div><dt>{t('terminal.limitUp')}</dt><dd className="terminal-mono term-up">{marketBreadth?.limitUpCount ?? '--'}</dd></div>
                  <div><dt>{t('terminal.limitDown')}</dt><dd className="terminal-mono term-down">{marketBreadth?.limitDownCount ?? '--'}</dd></div>
                </dl>
              </section>
              <section>
                <header><h2>{t('terminal.hotSectors')}</h2></header>
                {hotSectors.length > 0 ? <div className="terminal-sector-list">{hotSectors.map((sector) => <div key={sector.name}><span>{sector.name}</span><strong className={`terminal-mono ${(sector.changePct || 0) > 0 ? 'term-up' : (sector.changePct || 0) < 0 ? 'term-down' : ''}`}>{typeof sector.changePct === 'number' ? `${sector.changePct > 0 ? '+' : ''}${sector.changePct.toFixed(2)}%` : '--'}</strong></div>)}</div> : <p className="terminal-muted">{t('common.noData')}</p>}
              </section>
            </aside>
          </div>
        )}
      </section>

      {markdownDrawerOpen && selectedReport?.meta.id ? (
        <ReportMarkdownDrawer key={selectedReport.meta.id} recordId={selectedReport.meta.id} stockName={selectedReport.meta.stockName || ''} stockCode={selectedReport.meta.stockCode} reportLanguage={reportLanguage} onClose={closeMarkdownDrawer} />
      ) : null}

      {runFlowDrawer.open ? (
        <Drawer isOpen={runFlowDrawer.open} onClose={closeRunFlowDrawer} title={t('runFlow.drawerTitle')} width="max-w-[96vw]" zIndex={80}>
          <RunFlowPanel key={`${runFlowDrawer.source.type}-${runFlowDrawer.source.type === 'task' ? runFlowDrawer.source.taskId : runFlowDrawer.source.recordId}`} source={runFlowDrawer.source} title={runFlowDrawer.title} />
        </Drawer>
      ) : null}
    </div>
  );
};

export default HomePage;
