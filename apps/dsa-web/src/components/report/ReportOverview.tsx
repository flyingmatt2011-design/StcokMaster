import type React from 'react';
import type {
  ReportDetails as ReportDetailsType,
  ReportMeta,
  ReportStrategy as ReportStrategyType,
  ReportSummary as ReportSummaryType,
} from '../../types/analysis';
import { formatDateTime } from '../../utils/format';
import { getMarketPhaseSummaryLabel, getPartialBarLabel } from '../../utils/marketPhase';
import { getReportText, normalizeReportLanguage } from '../../utils/reportLanguage';
import { buildDecisionActionLabelMap, getDecisionActionLabel } from '../../utils/decisionAction';
import { useUiLanguage } from '../../contexts/UiLanguageContext';
import { ShareImageButton } from './ShareImageButton';
import { KronosForecastPanel } from './KronosForecastPanel';

interface ReportOverviewProps {
  meta: ReportMeta;
  summary: ReportSummaryType;
  strategy?: ReportStrategyType;
  details?: ReportDetailsType;
  isHistory?: boolean;
  newsPanel?: React.ReactNode;
}

type BoardStatus = 'leading' | 'lagging';

type BoardSignal = {
  status: BoardStatus;
  changePct?: number;
};

type BoardSignalMaps = {
  sectors: Map<string, BoardSignal>;
  concepts: Map<string, BoardSignal>;
};

type PreparedBoard = {
  key: string;
  name: string;
  signal?: BoardSignal;
};

const normalizeBoardName = (value?: string): string =>
  (value || '').trim().replace(/\s+/g, ' ');

const normalizeBoardType = (value?: string): 'sector' | 'concept' | null => {
  const normalized = (value || '').trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (['行业', '行业板块', 'industry', 'sector'].includes(normalized)) {
    return 'sector';
  }
  if (['概念', '概念板块', '题材', 'concept', 'theme'].includes(normalized)) {
    return 'concept';
  }
  return null;
};

const coerceFiniteNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim().replace(/%$/, '');
    if (!trimmed) {
      return undefined;
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
};

const buildRankingSignalMap = (rankings?: ReportDetailsType['sectorRankings']): Map<string, BoardSignal> => {
  const signalMap = new Map<string, BoardSignal>();
  const topBoards = Array.isArray(rankings?.top) ? rankings.top : [];
  const bottomBoards = Array.isArray(rankings?.bottom) ? rankings.bottom : [];

  topBoards.forEach((item) => {
    const normalizedName = normalizeBoardName(item?.name);
    const changePct = coerceFiniteNumber(item?.changePct);
    if (!normalizedName || changePct === undefined) {
      return;
    }
    signalMap.set(normalizedName, {
      status: 'leading',
      changePct,
    });
  });

  bottomBoards.forEach((item) => {
    const normalizedName = normalizeBoardName(item?.name);
    const changePct = coerceFiniteNumber(item?.changePct);
    if (!normalizedName || changePct === undefined) {
      return;
    }
    signalMap.set(normalizedName, {
      status: 'lagging',
      changePct,
    });
  });

  return signalMap;
};

const buildBoardSignalMaps = (details?: ReportDetailsType): BoardSignalMaps => ({
  sectors: buildRankingSignalMap(details?.sectorRankings),
  concepts: buildRankingSignalMap(details?.conceptRankings),
});

const resolveBoardSignal = (
  board: { name?: string; type?: string },
  signalMaps: BoardSignalMaps,
): BoardSignal | undefined => {
  const boardName = normalizeBoardName(board.name);
  if (!boardName) {
    return undefined;
  }
  const boardType = normalizeBoardType(board.type);
  if (boardType === 'sector') {
    return signalMaps.sectors.get(boardName);
  }
  if (boardType === 'concept') {
    return signalMaps.concepts.get(boardName);
  }
  const sectorSignal = signalMaps.sectors.get(boardName);
  const conceptSignal = signalMaps.concepts.get(boardName);
  if (sectorSignal && !conceptSignal) {
    return sectorSignal;
  }
  if (conceptSignal && !sectorSignal) {
    return conceptSignal;
  }
  return undefined;
};

const buildPreparedRelatedBoards = (
  boards: ReportDetailsType['belongBoards'],
  signalMaps: BoardSignalMaps,
): PreparedBoard[] => {
  if (!Array.isArray(boards)) {
    return [];
  }

  return boards.reduce<PreparedBoard[]>((preparedBoards, board, index) => {
    const boardName = normalizeBoardName(board?.name);
    if (!boardName) {
      return preparedBoards;
    }
    preparedBoards.push({
      key: `${boardName}-${board?.code || index}`,
      name: boardName,
      signal: resolveBoardSignal(board, signalMaps),
    });
    return preparedBoards;
  }, []);
};

/**
 * 报告概览区组件 - 终端风格
 */
export const ReportOverview: React.FC<ReportOverviewProps> = ({
  meta,
  summary,
  strategy,
  details,
  newsPanel,
}) => {
  const { t } = useUiLanguage();
  const reportLanguage = normalizeReportLanguage(meta.reportLanguage);
  const text = getReportText(reportLanguage);
  const marketPhaseLabel = getMarketPhaseSummaryLabel(meta.marketPhaseSummary, reportLanguage);
  const partialBarLabel = meta.marketPhaseSummary?.isPartialBar === true
    ? getPartialBarLabel(reportLanguage)
    : null;
  const relatedBoards = (Array.isArray(details?.belongBoards) ? details.belongBoards : [])
    .filter((board) => normalizeBoardName(board?.name).length > 0);
  const boardSignals = buildBoardSignalMaps(details);
  const preparedRelatedBoards = buildPreparedRelatedBoards(relatedBoards, boardSignals);

  const getPriceChangeStyle = (changePct: number | undefined): React.CSSProperties | undefined => {
    if (changePct === undefined || changePct === null) {
      return undefined;
    }
    if (changePct > 0) {
      return { color: 'var(--home-price-up)' };
    }

    if (changePct < 0) {
      return { color: 'var(--home-price-down)' };
    }

    return undefined;
  };

  const formatChangePct = (changePct: number | undefined): string => {
    if (changePct === undefined || changePct === null) return '--';
    const sign = changePct > 0 ? '+' : '';
    return `${sign}${changePct.toFixed(2)}%`;
  };

  const getBoardStatusLabel = (status: BoardStatus): string => {
    if (status === 'leading') {
      return text.leadingBoard;
    }
    return text.laggingBoard;
  };

  const actionLabels = buildDecisionActionLabelMap(t);
  const verdict = getDecisionActionLabel(
    summary.action,
    summary.actionLabel,
    summary.operationAdvice,
    text.actionAdvice,
    actionLabels,
  );
  const verdictTone = summary.action === 'buy' || summary.action === 'add'
    ? 'buy'
    : summary.action === 'sell' || summary.action === 'reduce'
      ? 'sell'
      : 'hold';
  const changeDirection = typeof meta.changePct === 'number' && meta.changePct !== 0
    ? meta.changePct > 0 ? '▲' : '▼'
    : '';
  const riskItems = Array.isArray(details?.riskAlerts) ? details.riskAlerts.filter(Boolean) : [];
  const catalystItems = Array.isArray(details?.positiveCatalysts) ? details.positiveCatalysts.filter(Boolean) : [];
  const checklist = [
    ...riskItems.slice(0, 3).map((item) => ({ status: 'WARN', tone: 'warn', text: item })),
    ...catalystItems.slice(0, 2).map((item) => ({ status: 'PASS', tone: 'pass', text: item })),
  ];
  const ladder = [
    { label: text.idealBuy, value: strategy?.idealBuy || details?.supportLevel || '--', note: strategy?.secondaryBuy, tone: 'buy' },
    { label: text.stopLoss, value: strategy?.stopLoss || '--', note: details?.supportLevel || undefined, tone: 'stop' },
    { label: text.takeProfit, value: strategy?.takeProfit || details?.resistanceLevel || '--', note: details?.resistanceLevel || undefined, tone: 'target' },
  ];

  return (
    <div className="stockmaster-report-overview terminal-report-overview" data-testid="report-overview">
      <header className="terminal-stock-head">
        <div className="terminal-stock-identity">
          <h2>{meta.stockName || meta.stockCode}</h2>
          <span className="terminal-mono">{meta.stockCode}</span>
        </div>
        {meta.currentPrice != null ? (
          <div className={`terminal-stock-price ${typeof meta.changePct === 'number' && meta.changePct > 0 ? 'term-up' : typeof meta.changePct === 'number' && meta.changePct < 0 ? 'term-down' : ''}`}>
            <strong className="terminal-mono">{meta.currentPrice.toFixed(2)} <small>{changeDirection}</small></strong>
            <span className="terminal-mono">{formatChangePct(meta.changePct)}</span>
          </div>
        ) : null}
        <div className="terminal-stock-meta">
          {marketPhaseLabel ? <span aria-label={marketPhaseLabel}>{marketPhaseLabel}</span> : null}
          {partialBarLabel ? <span className="is-amber" aria-label={partialBarLabel}>{partialBarLabel}</span> : null}
          <time className="terminal-mono">{formatDateTime(meta.createdAt)}</time>
          <ShareImageButton recordId={meta.id} reportTitle={`${meta.stockName || meta.stockCode}-${meta.stockCode}`} reportLanguage={reportLanguage} />
        </div>
      </header>

      <div className="terminal-report-grid">
        <main className="terminal-report-main">
          <section className={`terminal-verdict-panel is-${verdictTone}`}>
            <div className="terminal-verdict-top">
              <div className="terminal-verdict-callout">
                <span>{text.actionAdvice}</span>
                <strong>{verdict || text.noAdvice}</strong>
                <small>{summary.trendPrediction || text.noPrediction}</small>
              </div>
              <p>{summary.analysisSummary || text.noAnalysisSummary}</p>
              <div className="terminal-verdict-score">
                <strong className="terminal-mono">{summary.sentimentScore ?? '--'}</strong>
                <span>{text.marketSentiment}</span>
              </div>
            </div>
            <div className="terminal-price-ladder">
              {ladder.map((item) => (
                <div key={item.label} className={`is-${item.tone}`}>
                  <span>{item.label}</span>
                  <strong className="terminal-mono">{item.value}</strong>
                  {item.note && item.note !== item.value ? <small>{item.note}</small> : null}
                </div>
              ))}
            </div>
          </section>

          {checklist.length > 0 ? (
            <section className="terminal-report-panel">
              <header><h3>{t('terminal.rigorousChecks')}</h3><span className="terminal-meta">{checklist.length}</span></header>
              <div className="terminal-check-list">
                {checklist.map((item, index) => (
                  <div key={`${item.status}-${index}`}>
                    <span className={`terminal-check-state is-${item.tone}`}>{item.status === 'WARN' ? '▲' : '✓'} {item.status}</span>
                    <p>{item.text}</p>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          <section className="terminal-report-panel">
            <header><h3>{t('terminal.analysisPoints')}</h3></header>
            <div className="terminal-analysis-lines">
              <div><span>{text.keyInsights}</span><p>{details?.coreConclusion || summary.analysisSummary || text.noAnalysisSummary}</p></div>
              <div><span>{text.trendPrediction}</span><p>{summary.trendPrediction || text.noPrediction}</p></div>
              <div><span>{text.actionAdvice}</span><p>{summary.operationAdvice || text.noAdvice}</p></div>
            </div>
          </section>

          {details?.kronosForecast ? (
            <KronosForecastPanel forecast={details.kronosForecast} />
          ) : null}

          {newsPanel ? (
            <div className="terminal-report-news" data-testid="report-news-slot">
              {newsPanel}
            </div>
          ) : null}
        </main>

        <aside className="terminal-report-data">
          {preparedRelatedBoards.length > 0 ? (
            <section aria-label={text.relatedBoards}>
              <header><h3>{text.relatedBoards}</h3></header>
              <div className="home-related-board-list terminal-board-list">
                {preparedRelatedBoards.map((board) => (
                  <div key={board.key}>
                    <span>{board.name}</span>
                    {board.signal ? <em className={board.signal.status === 'leading' ? 'term-up' : 'term-down'}>{getBoardStatusLabel(board.signal.status)}</em> : null}
                    {board.signal?.changePct != null ? <strong className="terminal-mono" style={getPriceChangeStyle(board.signal.changePct)}>{formatChangePct(board.signal.changePct)}</strong> : null}
                  </div>
                ))}
              </div>
            </section>
          ) : null}
          <section>
            <header><h3>{t('terminal.keyLevels')}</h3></header>
            <dl className="terminal-data-list">
              <div><dt>{text.idealBuy}</dt><dd className="terminal-mono">{strategy?.idealBuy || details?.supportLevel || '--'}</dd></div>
              <div><dt>{text.stopLoss}</dt><dd className="terminal-mono term-down">{strategy?.stopLoss || '--'}</dd></div>
              <div><dt>{text.takeProfit}</dt><dd className="terminal-mono is-amber">{strategy?.takeProfit || details?.resistanceLevel || '--'}</dd></div>
            </dl>
          </section>
          {riskItems.length > 0 ? (
            <section><header><h3>{t('terminal.riskMarkers')}</h3></header><div className="terminal-tag-list">{riskItems.map((item) => <span key={item}>{item}</span>)}</div></section>
          ) : null}
          {catalystItems.length > 0 ? (
            <section><header><h3>{t('terminal.positiveFactors')}</h3></header><div className="terminal-tag-list">{catalystItems.map((item) => <span key={item}>{item}</span>)}</div></section>
          ) : null}
        </aside>
      </div>
    </div>
  );
};
