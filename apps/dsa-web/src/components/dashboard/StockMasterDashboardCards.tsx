import type React from 'react';
import { Activity, BrainCircuit, Database, FileText, ShieldCheck } from 'lucide-react';
import type { AnalysisReport } from '../../types/analysis';
import { ScoreGauge } from '../common';
import { getReportText, normalizeReportLanguage } from '../../utils/reportLanguage';
import { formatDateTime } from '../../utils/format';

interface StockMasterDashboardCardsProps {
  selectedReport: AnalysisReport | null;
}

export const StockMasterDashboardCards: React.FC<StockMasterDashboardCardsProps> = ({ selectedReport }) => {
  const score = typeof selectedReport?.summary.sentimentScore === 'number' ? selectedReport.summary.sentimentScore : null;
  const selectedName = selectedReport?.meta.stockName || selectedReport?.meta.stockCode || '等待选择股票';
  const stockCode = selectedReport?.meta.stockCode || '--';
  const currentPrice = selectedReport?.meta.currentPrice;
  const changePct = selectedReport?.meta.changePct;
  const analysisTime = selectedReport?.meta.createdAt ? formatDateTime(selectedReport.meta.createdAt) : '暂无分析记录';
  const operationAdvice = selectedReport?.summary.operationAdvice || '暂无建议';
  const trendPrediction = selectedReport?.summary.trendPrediction || '暂无趋势判断';
  const reportText = getReportText(normalizeReportLanguage(selectedReport?.meta.reportLanguage));
  const changeClass = typeof changePct !== 'number' || changePct === 0
    ? 'text-muted-text'
    : changePct > 0 ? 'text-[var(--home-price-up)]' : 'text-[var(--home-price-down)]';
  const rawResult = selectedReport?.details?.rawResult;
  const dashboard = rawResult && typeof rawResult.dashboard === 'object' && rawResult.dashboard !== null
    ? rawResult.dashboard as Record<string, unknown>
    : undefined;
  const calibration = dashboard && typeof dashboard.decision_score_calibration === 'object' && dashboard.decision_score_calibration !== null
    ? dashboard.decision_score_calibration as Record<string, unknown>
    : undefined;
  const attribution = dashboard && typeof dashboard.signal_attribution === 'object' && dashboard.signal_attribution !== null
    ? dashboard.signal_attribution as Record<string, unknown>
    : undefined;
  const rawScore = typeof calibration?.raw_score === 'number' ? calibration.raw_score : null;
  const adjustedScore = typeof calibration?.adjusted_score === 'number' ? calibration.adjusted_score : null;
  const guardrailReason = typeof calibration?.guardrail_reason === 'string' ? calibration.guardrail_reason.trim() : '';
  const overview = selectedReport?.details?.analysisContextPackOverview;
  const qualityScore = overview?.dataQuality?.overallScore;
  const degradedCount = (overview?.counts?.missing || 0)
    + (overview?.counts?.fetchFailed || 0)
    + (overview?.counts?.stale || 0)
    + (overview?.counts?.partial || 0)
    + (overview?.counts?.fallback || 0);
  const sources = Array.from(new Set(
    (overview?.blocks || []).map((block) => block.source?.trim()).filter((source): source is string => Boolean(source)),
  ));
  const attributionParts = [
    ['技术', attribution?.technical_indicators],
    ['新闻', attribution?.news_sentiment],
    ['基本面', attribution?.fundamentals],
    ['市场', attribution?.market_conditions],
  ].filter((item): item is [string, number] => typeof item[1] === 'number');
  const scoreProvenance = rawScore !== null && adjustedScore !== null && rawScore !== adjustedScore
    ? `规则校准 ${rawScore} → ${adjustedScore}${guardrailReason ? ` · ${guardrailReason}` : ''}`
    : '报告原始评分（界面未二次改分）';

  return (
    <section className="space-y-2" aria-label="StockMaster 报告概览">
      <div className="sm-report-summary-strip">
      <article className="sm-report-summary-stock">
        <div className="sm-report-summary-label">
          <FileText className="h-4 w-4" aria-hidden="true" />
          当前报告
        </div>
        <div className="mt-2 flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
          <h2 className="min-w-0 truncate text-lg font-semibold text-foreground">{selectedName}</h2>
          <span className="font-mono text-xs text-muted-text">{stockCode}</span>
        </div>
        <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          {typeof currentPrice === 'number' ? <span className="font-mono font-semibold text-foreground">{currentPrice.toFixed(2)}</span> : null}
          {typeof changePct === 'number' ? (
            <span className={`font-mono font-medium ${changeClass}`}>{changePct >= 0 ? '+' : ''}{changePct.toFixed(2)}%</span>
          ) : null}
          <span className="text-muted-text">最近分析 {analysisTime}</span>
        </div>
      </article>

      <article className="sm-report-summary-metric">
        <div className="sm-report-summary-label">
          <BrainCircuit className="h-4 w-4" aria-hidden="true" />
          AI 评分
        </div>
        <div className="mt-2 flex items-baseline gap-1">
          <strong className="font-mono text-2xl font-semibold text-foreground">{score ?? '--'}</strong>
          <span className="text-xs text-muted-text">/ 100</span>
        </div>
        <p className="mt-1 line-clamp-2 text-xs leading-5 text-secondary-text">{operationAdvice}</p>
      </article>

      <article className="sm-report-summary-metric">
        <div className="sm-report-summary-label">
          <Activity className="h-4 w-4" aria-hidden="true" />
          {reportText.marketSentiment}
        </div>
        <p className="mt-2 line-clamp-2 text-sm font-medium leading-5 text-foreground">{trendPrediction}</p>
      </article>

      <article className="sm-report-summary-gauge">
        <span className="sr-only">{reportText.fearGreedIndex}</span>
        <ScoreGauge
          score={score ?? 0}
          size="sm"
          showLabel={false}
          language={normalizeReportLanguage(selectedReport?.meta.reportLanguage)}
        />
      </article>
      </div>
      <div className="sm-report-trust-strip" data-testid="report-trust-strip">
        <span className="sm-report-trust-item" aria-label={scoreProvenance}>
          <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
          <strong>评分依据</strong> {scoreProvenance}
        </span>
        {attributionParts.length ? (
          <span className="sm-report-trust-item" aria-label="原报告给出的信号贡献度，不是 StockMaster 重新评分">
            <BrainCircuit className="h-3.5 w-3.5" aria-hidden="true" />
            {attributionParts.map(([label, value]) => `${label} ${value}`).join(' · ')}
          </span>
        ) : null}
        {typeof qualityScore === 'number' ? (
          <span className="sm-report-trust-item">
            <Database className="h-3.5 w-3.5" aria-hidden="true" />
            数据完整度 {qualityScore}/100{degradedCount ? ` · ${degradedCount} 项降级` : ' · 完整'}
          </span>
        ) : null}
        <span className="sm-report-trust-item">数据截止 {formatDateTime(overview?.createdAt || selectedReport?.meta.createdAt)}</span>
        {sources.length ? <span className="sm-report-trust-item" aria-label={sources.join('、')}>来源 {sources.slice(0, 3).join('、')}{sources.length > 3 ? ` +${sources.length - 3}` : ''}</span> : null}
        {typeof overview?.metadata?.newsResultCount === 'number' ? <span className="sm-report-trust-item">新闻 {overview.metadata.newsResultCount} 条</span> : null}
      </div>
    </section>
  );
};

export default StockMasterDashboardCards;
