import type React from 'react';
import { useMemo, useState } from 'react';
import { Play, Plus, RefreshCw, StopCircle, Trash2 } from 'lucide-react';
import { Button, InlineAlert, Input } from '../common';
import { DashboardStateBlock } from '../dashboard';
import { StockBar } from '../history';
import type { StockBarItem, TaskInfo } from '../../types/analysis';
import { contextualAdvice } from '../../utils/contextualAdvice';
import { formatDateTime } from '../../utils/format';
import { areStockCodesEquivalent } from '../../utils/stockCode';
import { useUiLanguage } from '../../contexts/UiLanguageContext';
import type { StockQuote } from '../../api/stocks';
import type { AShareQuoteRefreshState } from '../../hooks/useAshareQuoteRefresh';

export type HomeWorkspaceTab = 'watchlist' | 'today' | 'history';
export type WatchlistAnalyzeMode = 'all' | 'pending' | 'selected';

export interface HomeWatchlistRow {
  code: string;
  latestItem?: StockBarItem;
  quote?: StockQuote;
  analyzedToday: boolean;
  isTodayStatusLoading?: boolean;
  isTodayStatusUnknown?: boolean;
  activeTask?: TaskInfo;
  isHeld?: boolean;
}

interface BatchStatus {
  variant: 'success' | 'warning' | 'danger';
  message: string;
}

interface HomeStockWorkspaceProps {
  activeTab: HomeWorkspaceTab;
  onActiveTabChange?: (tab: HomeWorkspaceTab) => void;
  watchlistRows: HomeWatchlistRow[];
  watchlistLoading: boolean;
  watchlistActioning: boolean;
  watchlistMessage: string | null;
  onAddToWatchlist: (code: string) => Promise<void>;
  onRemoveFromWatchlist: (code: string) => Promise<void>;
  onRefreshWatchlist: () => Promise<void>;
  onAnalyzeWatchlist: (mode: WatchlistAnalyzeMode, selectedCodes?: string[]) => Promise<void>;
  onStopAnalyzeWatchlist: () => void;
  isBatchAnalyzing: boolean;
  isBatchStopRequested: boolean;
  batchStatus: BatchStatus | null;
  quoteRefreshState?: AShareQuoteRefreshState;
  todayItems: StockBarItem[];
  isLoadingTodayItems: boolean;
  todayLoadError: boolean;
  historyItems: StockBarItem[];
  isLoadingHistory: boolean;
  selectedStockCode?: string;
  selectedRecordId?: number;
  onHistoryItemClick: (recordId: number) => void;
  onDeleteStock?: (stockCode: string) => Promise<void> | void;
  isDeleting?: boolean;
  className?: string;
}

type WatchlistFilter = 'all' | 'action' | 'held' | 'observe';
type WatchlistSort = 'score' | 'change' | 'recent';

const ACTION_SIGNAL_SET = new Set(['buy', 'add', 'reduce', 'sell']);

function timeValue(value?: string): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function getVerdict(row: HomeWatchlistRow): string {
  return contextualAdvice(
    row.latestItem?.action,
    row.latestItem?.operationAdvice,
    row.isHeld ? 'held' : 'unheld',
  );
}

function getVerdictTone(row: HomeWatchlistRow): 'buy' | 'sell' | 'hold' {
  const action = row.latestItem?.action;
  if (action === 'buy' || action === 'add') return 'buy';
  if (action === 'reduce' || action === 'sell') return 'sell';
  return 'hold';
}

function rowChangePct(row: HomeWatchlistRow): number | undefined {
  return row.quote?.changePercent ?? row.latestItem?.changePct;
}

function formatPrice(value?: number): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(2) : '--';
}

function formatChange(value?: number): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '--';
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function formatStrategyPoint(value?: string): string {
  if (!value) return '--';
  const matched = value.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  if (!matched) return '--';
  const parsed = Number(matched[0]);
  return Number.isFinite(parsed) ? parsed.toFixed(2) : '--';
}

function changeTone(value?: number): string {
  if (typeof value !== 'number' || value === 0) return 'term-flat';
  return value > 0 ? 'term-up' : 'term-down';
}

function compactTime(value?: string): string {
  if (!value) return '--';
  return formatDateTime(value).replace(/^\d{4}\//, '');
}

type Translator = ReturnType<typeof useUiLanguage>['t'];

function quoteSourceLabel(source?: string | null): string {
  const labels: Record<string, string> = {
    efinance: '东财',
    akshare_em: '东财',
    akshare_sina: '新浪',
    akshare_qq: '腾讯',
    tencent: '腾讯',
    sina: '新浪',
    tushare: 'Tushare',
    tickflow: 'TickFlow',
    stooq: 'Stooq',
    longbridge: 'Longbridge',
    fallback: 'Fallback',
  };
  return source ? labels[source] || source : '--';
}

function quoteAgeLabel(quote: StockQuote, t: Translator): string {
  const timestamp = quote.lastSuccessAt || quote.fetchedAt || quote.updateTime;
  const parsed = timestamp ? Date.parse(timestamp) : Number.NaN;
  if (!Number.isFinite(parsed)) return '--';
  const seconds = Math.max(0, Math.floor((Date.now() - parsed) / 1000));
  if (seconds < 2) return t('terminal.quoteAgeNow');
  if (seconds < 60) return t('terminal.quoteAgeSeconds', { seconds });
  return t('terminal.quoteAgeMinutes', { minutes: Math.floor(seconds / 60) });
}

function quoteRefreshLabel(
  state: AShareQuoteRefreshState | undefined,
  isBatchAnalyzing: boolean,
  language: 'zh' | 'en',
  t: Translator,
): string {
  if (state?.policyUnavailable) return t('terminal.quoteRefreshUnavailable');
  if (!state?.policy) return t('terminal.quoteRefreshPending');
  if (state.policy.isMarketOpenNow) {
    const seconds = Math.round((state.cadenceMs || 5_000) / 1_000);
    return isBatchAnalyzing
      ? t('terminal.quoteRefreshBatch', { seconds })
      : t('terminal.quoteRefreshLive', { seconds });
  }
  if (state.policy.phase === 'lunch_break' && state.policy.nextTransitionAt) {
    const time = new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(state.policy.nextTransitionAt));
    return t('terminal.quoteRefreshLunch', { time });
  }
  return t('terminal.quoteRefreshPaused');
}

const TerminalStatus: React.FC<{ task: TaskInfo }> = ({ task }) => (
  <span className={`terminal-task-state ${task.status === 'processing' ? 'is-running' : ''}`}>
    {task.status === 'processing' ? 'RUN' : 'QUEUE'} {Math.max(0, Math.min(100, task.progress || 0))}%
  </span>
);

export const HomeStockWorkspace: React.FC<HomeStockWorkspaceProps> = ({
  activeTab,
  onActiveTabChange,
  watchlistRows,
  watchlistLoading,
  watchlistActioning,
  watchlistMessage,
  onAddToWatchlist,
  onRemoveFromWatchlist,
  onRefreshWatchlist,
  onAnalyzeWatchlist,
  onStopAnalyzeWatchlist,
  isBatchAnalyzing,
  isBatchStopRequested,
  batchStatus,
  quoteRefreshState,
  todayItems,
  isLoadingTodayItems,
  todayLoadError,
  historyItems,
  isLoadingHistory,
  selectedStockCode,
  selectedRecordId,
  onHistoryItemClick,
  onDeleteStock,
  isDeleting = false,
  className = '',
}) => {
  const { language, t } = useUiLanguage();
  const [draftCode, setDraftCode] = useState('');
  const [selectedCodes, setSelectedCodes] = useState<string[]>([]);
  const [filter, setFilter] = useState<WatchlistFilter>('all');
  const [sort, setSort] = useState<WatchlistSort>('score');
  const [workspaceNoticeCode, setWorkspaceNoticeCode] = useState<string | null>(null);

  const selectedRowCodes = useMemo(
    () => watchlistRows
      .filter((row) => selectedCodes.some((code) => areStockCodesEquivalent(row.code, code)))
      .map((row) => row.code),
    [selectedCodes, watchlistRows],
  );

  const visibleRows = useMemo(() => {
    const filtered = watchlistRows.filter((row) => {
      if (filter === 'held') return Boolean(row.isHeld);
      if (filter === 'action') return ACTION_SIGNAL_SET.has(row.latestItem?.action || '');
      if (filter === 'observe') return !ACTION_SIGNAL_SET.has(row.latestItem?.action || '');
      return true;
    });
    return [...filtered].sort((left, right) => {
      if (sort === 'change') return (rowChangePct(right) ?? -Infinity) - (rowChangePct(left) ?? -Infinity);
      if (sort === 'recent') return timeValue(right.latestItem?.lastAnalysisTime) - timeValue(left.latestItem?.lastAnalysisTime);
      return (right.latestItem?.sentimentScore ?? -Infinity) - (left.latestItem?.sentimentScore ?? -Infinity);
    });
  }, [filter, sort, watchlistRows]);

  const allVisibleSelected = visibleRows.length > 0 && visibleRows.every(
    (row) => selectedRowCodes.some((code) => areStockCodesEquivalent(row.code, code)),
  );

  const visibleWorkspaceNotice = useMemo(() => {
    if (!workspaceNoticeCode) return null;
    const row = watchlistRows.find((item) => areStockCodesEquivalent(item.code, workspaceNoticeCode));
    if (!row) return null;
    if (row.isTodayStatusLoading) return t('watchlist.latestDetailLoading');
    if (row.isTodayStatusUnknown) return t('watchlist.latestDetailUnavailable');
    if (!row.latestItem) return t('watchlist.noLatestDetail');
    return null;
  }, [t, watchlistRows, workspaceNoticeCode]);

  const handleToggleSelection = (code: string) => {
    setSelectedCodes((current) => current.some((item) => areStockCodesEquivalent(item, code))
      ? current.filter((item) => !areStockCodesEquivalent(item, code))
      : [...current, code]);
  };

  const handleToggleAll = () => {
    if (allVisibleSelected) {
      setSelectedCodes((current) => current.filter(
        (code) => !visibleRows.some((row) => areStockCodesEquivalent(row.code, code)),
      ));
      return;
    }
    setSelectedCodes((current) => Array.from(new Set([...current, ...visibleRows.map((row) => row.code)])));
  };

  const handleOpenRow = (row: HomeWatchlistRow) => {
    if (row.isTodayStatusLoading || row.isTodayStatusUnknown || typeof row.latestItem?.id !== 'number') {
      setWorkspaceNoticeCode(row.code);
      return;
    }
    setWorkspaceNoticeCode(null);
    onHistoryItemClick(row.latestItem.id);
  };

  const handleAdd = (event: React.FormEvent) => {
    event.preventDefault();
    const code = draftCode.trim();
    if (!code) return;
    void onAddToWatchlist(code).then(() => setDraftCode(''));
  };

  const workspaceTabs = (
    <nav className="terminal-workspace-tabs" aria-label={t('watchlist.workspaceTitle')}>
      {(['watchlist', 'today', 'history'] as const).map((tab) => (
        <button
          key={tab}
          type="button"
          className={activeTab === tab ? 'is-active' : ''}
          aria-pressed={activeTab === tab}
          onClick={() => onActiveTabChange?.(tab)}
        >
          {t(`watchlist.tab${tab === 'watchlist' ? 'Watchlist' : tab === 'today' ? 'Today' : 'History'}`)}
        </button>
      ))}
    </nav>
  );

  if (activeTab === 'history') {
    return (
      <div data-testid="home-stock-workspace" className={`terminal-watchlist-history min-h-0 ${className}`}>
        {workspaceTabs}
        <StockBar
          items={historyItems}
          isLoading={isLoadingHistory}
          selectedStockCode={selectedStockCode}
          selectedRecordId={selectedRecordId}
          onItemClick={onHistoryItemClick}
          onDeleteStock={onDeleteStock}
          isDeleting={isDeleting}
          className="h-full"
        />
      </div>
    );
  }

  if (activeTab === 'today') {
    return (
      <section data-testid="home-stock-workspace" className={`terminal-watchlist-board min-h-0 ${className}`}>
        {workspaceTabs}
        <header className="terminal-block-head">
          <h2>{t('watchlist.todayTitle')}</h2>
          <span className="terminal-meta">{t('common.itemsCount', { count: todayItems.length })}</span>
        </header>
        <div className="terminal-simple-list">
          {isLoadingTodayItems ? <DashboardStateBlock loading compact title={t('watchlist.loading')} /> : null}
          {todayLoadError ? <DashboardStateBlock compact title={t('watchlist.todayLoadErrorTitle')} /> : null}
          {!isLoadingTodayItems && !todayLoadError && todayItems.map((item) => (
            <button key={item.id} type="button" onClick={() => onHistoryItemClick(item.id)}>
              <strong>{item.stockName || item.stockCode}</strong>
              <span className="terminal-mono">{item.stockCode}</span>
              <span className="terminal-mono">{item.sentimentScore ?? '--'}</span>
            </button>
          ))}
        </div>
      </section>
    );
  }

  const filters: Array<{ key: WatchlistFilter; label: string; count: number }> = [
    { key: 'all', label: t('watchlist.filterAll'), count: watchlistRows.length },
    { key: 'action', label: t('terminal.actionSignals'), count: watchlistRows.filter((row) => ACTION_SIGNAL_SET.has(row.latestItem?.action || '')).length },
    { key: 'held', label: t('watchlist.filterHeld'), count: watchlistRows.filter((row) => row.isHeld).length },
    { key: 'observe', label: t('terminal.observe'), count: watchlistRows.filter((row) => !ACTION_SIGNAL_SET.has(row.latestItem?.action || '')).length },
  ];

  return (
    <section data-testid="home-stock-workspace" data-density="terminal" className={`terminal-watchlist-board flex min-h-0 flex-col ${className}`}>
      {workspaceTabs}
      <header className="terminal-block-head terminal-watchlist-head">
        <div>
          <h2>{t('terminal.watchlistBoard')}</h2>
          <div className="terminal-watchlist-meta-line">
            <span className="terminal-meta">{t('terminal.sortedByScore', { count: watchlistRows.length })}</span>
            <span
              className={`terminal-quote-refresh ${quoteRefreshState?.policyUnavailable ? 'is-warning' : quoteRefreshState?.policy?.isMarketOpenNow ? 'is-live' : 'is-paused'}`}
              data-testid="watchlist-quote-refresh-status"
            >
              {quoteRefreshLabel(quoteRefreshState, isBatchAnalyzing, language, t)}
            </span>
          </div>
        </div>
        <div className="terminal-head-actions">
          <form onSubmit={handleAdd} className="terminal-inline-add">
            <Input value={draftCode} onChange={(event) => setDraftCode(event.target.value)} placeholder={t('watchlist.addPlaceholder')} disabled={watchlistActioning} aria-label={t('watchlist.addPlaceholder')} />
            <Button type="submit" variant="secondary" size="sm" disabled={!draftCode.trim() || watchlistActioning} aria-label={t('watchlist.add')}>
              <Plus className="h-4 w-4" aria-hidden="true" />
            </Button>
          </form>
          <Button type="button" variant="ghost" size="sm" disabled={watchlistLoading} onClick={() => void onRefreshWatchlist()} aria-label={t('watchlist.refreshAria')}>
            <RefreshCw className={`h-4 w-4 ${watchlistLoading ? 'animate-spin' : ''}`} aria-hidden="true" />
            {t('watchlist.refresh')}
          </Button>
        </div>
      </header>

      <div className="terminal-watchlist-controls">
        <div className="terminal-filter-row" role="group" aria-label={t('watchlist.filterAria')}>
          {filters.map((item) => (
            <button key={item.key} type="button" className={filter === item.key ? 'is-active' : ''} onClick={() => setFilter(item.key)} aria-pressed={filter === item.key}>
              {item.label} <span className="terminal-mono">{item.count}</span>
            </button>
          ))}
        </div>
        <div className="terminal-batch-row">
          <label>
            <input type="checkbox" checked={allVisibleSelected} disabled={visibleRows.length === 0 || isBatchAnalyzing} onChange={handleToggleAll} data-testid="watchlist-select-all" />
            {t('watchlist.selectAll')}
          </label>
          <span className="terminal-meta" data-testid="watchlist-selected-count">{t('watchlist.selectedCount', { count: selectedRowCodes.length })}</span>
          <Button type="button" size="sm" variant="secondary" disabled={selectedRowCodes.length === 0 || isBatchAnalyzing} onClick={() => void onAnalyzeWatchlist('selected', selectedRowCodes)} data-testid="watchlist-analyze-selected">
            <Play className="h-4 w-4" aria-hidden="true" />
            {t('watchlist.analyzeSelected')}
          </Button>
          {isBatchAnalyzing ? (
            <Button type="button" size="sm" variant="secondary" disabled={isBatchStopRequested} onClick={onStopAnalyzeWatchlist} data-testid="watchlist-stop-analysis">
              <StopCircle className="h-4 w-4" aria-hidden="true" />
              {isBatchStopRequested ? t('watchlist.stoppingAnalysis') : t('watchlist.stopAnalysis')}
            </Button>
          ) : null}
        </div>
      </div>

      {batchStatus ? <div className={`terminal-notice is-${batchStatus.variant}`}>{batchStatus.message}</div> : null}
      {watchlistMessage ? <div className="terminal-notice">{watchlistMessage}</div> : null}
      {visibleWorkspaceNotice ? <InlineAlert variant="warning" message={visibleWorkspaceNotice} className="terminal-inline-alert" /> : null}

      <div className="terminal-table-scroll min-h-0 flex-1">
        {watchlistLoading ? (
          <DashboardStateBlock loading compact title={t('watchlist.loading')} />
        ) : watchlistRows.length === 0 ? (
          <DashboardStateBlock compact title={t('watchlist.emptyTitle')} description={t('watchlist.emptyDescription')} />
        ) : visibleRows.length === 0 ? (
          <DashboardStateBlock compact title={t('watchlist.filterEmpty')} />
        ) : (
          <table className="terminal-watchlist-table">
            <thead>
              <tr>
                <th className="terminal-spine" aria-hidden="true" />
                <th className="terminal-select-col"><span className="sr-only">{t('watchlist.selectAll')}</span></th>
                <th>{t('terminal.symbol')}</th>
                <th className="is-numeric">{t('terminal.price')}</th>
                <th className="is-numeric"><button type="button" onClick={() => setSort('change')}>{t('terminal.changePct')}</button></th>
                <th className="is-numeric"><button type="button" onClick={() => setSort('score')}>{t('terminal.score')}</button></th>
                <th>{t('terminal.verdict')}</th>
                <th className="is-numeric">{t('terminal.entry')}</th>
                <th className="is-numeric">{t('terminal.stop')}</th>
                <th className="is-numeric">{t('terminal.deviation')}</th>
                <th><button type="button" onClick={() => setSort('recent')}>{t('terminal.updated')}</button></th>
                <th><span className="sr-only">{t('common.delete')}</span></th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row) => {
                const item = row.latestItem;
                const currentPrice = row.quote?.currentPrice ?? item?.currentPrice;
                const changePct = rowChangePct(row);
                const tone = getVerdictTone(row);
                const todayStateLabel = row.isTodayStatusLoading
                  ? t('watchlist.todayStatusLoading')
                  : row.isTodayStatusUnknown
                    ? t('watchlist.todayStatusUnavailable')
                    : row.analyzedToday
                      ? t('watchlist.analyzedToday')
                      : t('watchlist.notAnalyzedToday');
                const detailAriaLabel = row.isTodayStatusLoading
                  ? t('watchlist.latestDetailLoadingAria', { code: row.code })
                  : row.isTodayStatusUnknown
                    ? t('watchlist.latestDetailUnavailableAria', { code: row.code })
                    : !item
                      ? t('watchlist.noLatestDetailAria', { code: row.code })
                      : t('watchlist.openLatestDetailAria', { code: row.code });
                const detailStatus = row.isTodayStatusLoading
                  ? t('watchlist.latestDetailLoadingCta')
                  : row.isTodayStatusUnknown
                    ? t('watchlist.latestDetailUnavailableCta')
                    : !item
                      ? t('watchlist.noLatestDetailCta')
                      : getVerdict(row);
                const selected = selectedRowCodes.some((code) => areStockCodesEquivalent(code, row.code));
                const isCurrent = (typeof selectedRecordId === 'number' && selectedRecordId === item?.id)
                  || Boolean(selectedStockCode && areStockCodesEquivalent(selectedStockCode, row.code));
                return (
                  <tr
                    key={row.code}
                    className={isCurrent ? 'is-current' : ''}
                    onClick={(event) => {
                      if ((event.target as HTMLElement).closest('button,input,a')) return;
                      handleOpenRow(row);
                    }}
                    data-testid={`watchlist-row-${row.code}`}
                  >
                    <td className={`terminal-spine is-${tone}`} aria-hidden="true"><i /></td>
                    <td className="terminal-select-col">
                      <input type="checkbox" checked={selected} disabled={watchlistActioning} onChange={() => handleToggleSelection(row.code)} data-testid={`watchlist-select-${row.code}`} aria-label={t('watchlist.selectAria', { code: row.code })} />
                    </td>
                    <td>
                      <button
                        type="button"
                        className="terminal-symbol"
                        aria-label={detailAriaLabel}
                        aria-pressed={isCurrent}
                        onClick={() => handleOpenRow(row)}
                      >
                        <strong>{item?.stockName || row.quote?.stockName || row.code}</strong>
                        <span className="terminal-mono">
                          {row.code}{row.isHeld ? ` · ${t('terminal.held')}` : ''}
                          <i className={`terminal-today-dot ${row.isTodayStatusLoading || row.isTodayStatusUnknown ? 'is-pending' : row.analyzedToday ? 'is-ready' : ''}`} aria-label={todayStateLabel} />
                        </span>
                      </button>
                    </td>
                    <td className="is-numeric terminal-mono terminal-quote-cell">
                      <strong>{formatPrice(currentPrice)}</strong>
                      {row.quote ? (
                        <span
                          className={row.quote.isStale || row.quote.refreshStatus === 'failed' ? 'is-stale' : ''}
                          aria-label={t('terminal.quoteMetaAria', {
                            source: quoteSourceLabel(row.quote.source),
                            time: row.quote.lastSuccessAt ? formatDateTime(row.quote.lastSuccessAt) : '--',
                            status: row.quote.refreshStatus === 'failed'
                              ? t('terminal.quoteFailed')
                              : row.quote.isStale
                                ? t('terminal.quoteStale')
                                : quoteAgeLabel(row.quote, t),
                          })}
                        >
                          {quoteSourceLabel(row.quote.source)} · {row.quote.refreshStatus === 'failed'
                            ? t('terminal.quoteFailed')
                            : row.quote.isStale
                              ? `${t('terminal.quoteStale')} ${quoteAgeLabel(row.quote, t)}`
                              : quoteAgeLabel(row.quote, t)}
                        </span>
                      ) : null}
                    </td>
                    <td className={`is-numeric terminal-mono ${changeTone(changePct)}`}>{formatChange(changePct)}</td>
                    <td className="is-numeric terminal-mono terminal-score">{item?.sentimentScore ?? '--'}</td>
                    <td>{row.activeTask ? <TerminalStatus task={row.activeTask} /> : <span className={`terminal-verdict is-${tone}`}>{detailStatus}</span>}</td>
                    <td className="is-numeric terminal-mono">{formatStrategyPoint(item?.idealBuy)}</td>
                    <td className="is-numeric terminal-mono">{formatStrategyPoint(item?.stopLoss)}</td>
                    <td className={`is-numeric terminal-mono ${changeTone(item?.biasMa5)}`}>{formatChange(item?.biasMa5)}</td>
                    <td
                      className="terminal-mono terminal-update"
                      aria-label={item?.lastAnalysisTime ? t('watchlist.lastAnalysis', { time: formatDateTime(item.lastAnalysisTime) }) : undefined}
                    >
                      {row.activeTask ? `${Math.round(row.activeTask.progress || 0)}%` : compactTime(item?.lastAnalysisTime)}
                    </td>
                    <td>
                      <button type="button" className="terminal-icon-button" disabled={watchlistActioning} onClick={() => void onRemoveFromWatchlist(row.code)} aria-label={t('watchlist.removeAria', { code: row.code })}>
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
};

export default HomeStockWorkspace;
