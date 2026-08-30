import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StockMasterDashboardCards } from '../StockMasterDashboardCards';

describe('StockMasterDashboardCards', () => {
  it('renders selected report summary metrics without duplicating report conclusions', async () => {
    render(
      <StockMasterDashboardCards
        selectedReport={{
          meta: { id: 7, queryId: 'q-7', stockCode: '600519', stockName: '贵州茅台', reportType: 'full', createdAt: '2026-08-12' },
          summary: { analysisSummary: '回踩支撑后再观察', operationAdvice: '观察', trendPrediction: '震荡', sentimentScore: 59 },
          details: { coreConclusion: '回踩支撑后再观察' },
        }}
      />,
    );

    expect(screen.getByText('贵州茅台')).toBeInTheDocument();
    expect(screen.getByText('观察')).toBeInTheDocument();
    expect(screen.getByText('震荡')).toBeInTheDocument();
    expect(screen.getByText('59')).toBeInTheDocument();
    expect(screen.queryByText('回踩支撑后再观察')).not.toBeInTheDocument();
    expect(screen.getByText('市场情绪')).toBeInTheDocument();
    expect(screen.getByText('恐惧贪婪指数')).toBeInTheDocument();
  });

  it('shows score calibration and data trust metadata from the existing report payload', () => {
    render(<StockMasterDashboardCards selectedReport={{
      meta: { id: 8, queryId: 'q-8', stockCode: '000001', stockName: '平安银行', reportType: 'detailed', createdAt: '2026-08-19T10:00:00+08:00' },
      summary: { analysisSummary: 'summary', operationAdvice: '观察', trendPrediction: '震荡', sentimentScore: 59 },
      details: {
        rawResult: { dashboard: { decision_score_calibration: { raw_score: 72, adjusted_score: 59, guardrail_reason: '资金流数据缺失' } } },
        analysisContextPackOverview: {
          packVersion: '1', subject: { code: '000001' },
          blocks: [{ key: 'quote', label: '行情', status: 'available', source: 'akshare', warnings: [], missingReasons: [] }],
          counts: { available: 1, missing: 0, notSupported: 0, fallback: 0, stale: 0, estimated: 0, partial: 0, fetchFailed: 0 },
          dataQuality: { overallScore: 92, level: 'good', blockScores: {}, limitations: [] }, warnings: [], metadata: { newsResultCount: 6 },
        },
      },
    }} />);
    expect(screen.getByTestId('report-trust-strip')).toHaveTextContent('规则校准 72 → 59');
    expect(screen.getByTestId('report-trust-strip')).toHaveTextContent('数据完整度 92/100');
    expect(screen.getByTestId('report-trust-strip')).toHaveTextContent('来源 akshare');
  });

  it('labels an uncalibrated score as report data instead of a UI fallback', () => {
    render(<StockMasterDashboardCards selectedReport={{
      meta: { id: 9, queryId: 'q-9', stockCode: '600143', stockName: '金发科技', reportType: 'detailed', createdAt: '2026-08-19T10:00:00+08:00' },
      summary: { analysisSummary: 'summary', operationAdvice: '观察', trendPrediction: '震荡', sentimentScore: 59 },
    }} />);

    expect(screen.getByTestId('report-trust-strip')).toHaveTextContent('报告原始评分（界面未二次改分）');
  });

  it('renders the sequential score trace when the backend supplies one', () => {
    render(<StockMasterDashboardCards selectedReport={{
      meta: { id: 10, queryId: 'q-10', stockCode: '000002', stockName: '万科A', reportType: 'detailed', createdAt: '2026-08-29T10:00:00+08:00' },
      summary: { analysisSummary: 'summary', operationAdvice: '观察', trendPrediction: '震荡', sentimentScore: 52 },
      details: { rawResult: { dashboard: { score_trace: [
        { stage: 'llm_output', score: 72 },
        { stage: 'structure_and_fundamentals', score: 59, reason: ['资金流约束'] },
        { stage: 'daily_market_context', score: 52, reason: ['大盘约束'] },
      ] } } },
    }} />);

    expect(screen.getByTestId('report-trust-strip')).toHaveTextContent('评分轨迹 72 → 59（资金流约束） → 52（大盘约束）');
  });
});
