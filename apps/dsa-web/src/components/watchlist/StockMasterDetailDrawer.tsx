import type React from 'react';
import { useEffect, useState } from 'react';
import { Send, Square } from 'lucide-react';
import type { AnalysisReport } from '../../types/analysis';
import { Drawer } from '../common/Drawer';
import { useAgentChatStore } from '../../stores/agentChatStore';
import { buildChatFollowUpContext } from '../../utils/chatFollowUp';
import { generateUUID } from '../../utils/uuid';

function reportSessionId(report: AnalysisReport): string | null {
  const recordId = report.meta.id;
  return typeof recordId === 'number' ? `stockmaster-report:${report.meta.stockCode}:${recordId}` : null;
}

function trendLabel(value?: string): string {
  if (!value) return '暂无趋势';
  const normalized = value.toLowerCase();
  if (value.includes('看空') || normalized.includes('bear')) return '看空';
  if (value.includes('看多') || normalized.includes('bull')) return '看多';
  return '震荡';
}

const ReportChatDock: React.FC<{ report: AnalysisReport }> = ({ report }) => {
  const [draft, setDraft] = useState('');
  const [expanded, setExpanded] = useState(false);
  const sessionId = reportSessionId(report);
  const messages = useAgentChatStore((state) => state.messages);
  const loading = useAgentChatStore((state) => state.loading);
  const stopStream = useAgentChatStore((state) => state.stopStream);
  const switchSession = useAgentChatStore((state) => state.switchSession);
  const startStream = useAgentChatStore((state) => state.startStream);

  useEffect(() => {
    if (sessionId) void switchSession(sessionId);
  }, [sessionId, switchSession]);

  const send = async () => {
    const message = draft.trim();
    if (!message || !sessionId || loading) return;
    setDraft('');
    setExpanded(true);
    await startStream({
      message,
      session_id: sessionId,
      request_id: generateUUID(),
      context: buildChatFollowUpContext(report.meta.stockCode, report.meta.stockName, report),
    });
  };

  return (
    <div className={`border-t border-border/70 bg-card px-4 py-3 ${expanded ? 'min-h-[45%]' : ''}`}>
      {expanded ? (
        <div className="mb-3 max-h-64 space-y-2 overflow-y-auto rounded-xl bg-base/50 p-3 text-sm">
          {messages.length === 0 ? <p className="text-muted-text">针对当前分析提问，AI 会沿用本次报告上下文。</p> : null}
          {messages.map((message) => (
            <div key={message.id} className={message.role === 'user' ? 'text-primary' : 'text-foreground'}>
              <span className="mr-1 text-[10px] uppercase text-muted-text">{message.role === 'user' ? '你' : 'AI'}</span>
              {message.content}
            </div>
          ))}
        </div>
      ) : null}
      <div className="flex items-center gap-2">
        <input
          value={draft}
          disabled={!sessionId || loading}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') void send(); }}
          placeholder={sessionId ? '针对本次分析提问…' : '分析保存后可提问'}
          className="input-surface h-10 min-w-0 flex-1 rounded-xl px-3 text-sm"
        />
        {loading ? (
          <button type="button" aria-label="停止回答" onClick={() => void stopStream()} className="btn-secondary h-10 w-10 px-0"><Square className="h-4 w-4" /></button>
        ) : (
          <button type="button" aria-label="发送问题" onClick={() => void send()} className="btn-primary h-10 w-10 px-0" disabled={!draft.trim() || !sessionId}><Send className="h-4 w-4" /></button>
        )}
      </div>
    </div>
  );
};

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function asText(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const text = String(value).trim();
  return text || undefined;
}

function asTextList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(asText).filter((item): item is string => Boolean(item)) : [];
}

function getStructuredDetail(report: AnalysisReport) {
  const details = report.details;
  const dashboard = asRecord(details?.rawResult?.dashboard);
  const core = asRecord(dashboard.core_conclusion);
  const intelligence = asRecord(dashboard.intelligence);
  const perspective = asRecord(dashboard.data_perspective);
  const price = asRecord(perspective.price_position);
  const trend = asRecord(perspective.trend_status);
  const volume = asRecord(perspective.volume_analysis);
  const battle = asRecord(dashboard.battle_plan);
  const sniper = asRecord(battle.sniper_points);
  const position = asRecord(core.position_advice);

  return {
    coreConclusion: details?.coreConclusion || asText(core.one_sentence) || report.summary.analysisSummary,
    noPositionAdvice: asText(position.no_position),
    hasPositionAdvice: asText(position.has_position),
    riskAlerts: details?.riskAlerts?.length ? details.riskAlerts : asTextList(intelligence.risk_alerts),
    positiveCatalysts: details?.positiveCatalysts?.length ? details.positiveCatalysts : asTextList(intelligence.positive_catalysts),
    news: details?.newsContent || asText(intelligence.latest_news),
    support: details?.supportLevel || asText(price.support_level),
    resistance: details?.resistanceLevel || asText(price.resistance_level),
    stopLoss: report.strategy?.stopLoss || asText(sniper.stop_loss),
    takeProfit: report.strategy?.takeProfit || asText(sniper.take_profit),
    currentPrice: asText(price.current_price) || asText(report.meta.currentPrice),
    ma5: asText(price.ma5),
    ma10: asText(price.ma10),
    ma20: asText(price.ma20),
    biasStatus: asText(price.bias_status),
    volumeRatio: asText(volume.volume_ratio),
    volumeStatus: asText(volume.volume_status),
    trendStatus: asText(trend.ma_alignment) || trendLabel(report.summary.trendPrediction),
  };
}

export const StockMasterDetailDrawer: React.FC<{ report: AnalysisReport; isOpen: boolean; onClose: () => void }> = ({ report, isOpen, onClose }) => {
  const details = getStructuredDetail(report);
  return (
    <Drawer isOpen={isOpen} onClose={onClose} title={`${report.meta.stockName || report.meta.stockCode} · 分析详情`} width="max-w-2xl" zIndex={90}>
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-xl bg-base/60 p-3"><p className="text-xs text-muted-text">AI评分</p><p className="mt-1 text-2xl font-bold">{report.summary.sentimentScore ?? '—'}</p></div>
            <div className="rounded-xl bg-base/60 p-3"><p className="text-xs text-muted-text">原始建议</p><p className="mt-1 font-semibold">{report.summary.operationAdvice || '暂无数据'}</p></div>
            <div className="rounded-xl bg-base/60 p-3"><p className="text-xs text-muted-text">趋势</p><p className="mt-1 font-semibold">{trendLabel(report.summary.trendPrediction)}</p></div>
            <div className="rounded-xl bg-base/60 p-3"><p className="text-xs text-muted-text">更新时间</p><p className="mt-1 text-xs">{report.meta.createdAt || '暂无数据'}</p></div>
          </section>
          <section className="rounded-xl border border-subtle bg-base/35 p-4"><h3 className="font-semibold">核心结论</h3><p className="mt-2 text-sm leading-6 text-secondary-text">结论：{details.coreConclusion || '暂无数据'}</p>{details.noPositionAdvice || details.hasPositionAdvice ? <div className="mt-3 grid gap-2 text-sm sm:grid-cols-2"><div><span className="text-xs text-muted-text">空仓建议</span><p className="mt-1 text-secondary-text">{details.noPositionAdvice || '暂无数据'}</p></div><div><span className="text-xs text-muted-text">持仓建议</span><p className="mt-1 text-secondary-text">{details.hasPositionAdvice || '暂无数据'}</p></div></div> : null}</section>
          <section className="grid gap-3 sm:grid-cols-2">
            <div><h3 className="font-semibold">风险提示</h3><ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-secondary-text">{details.riskAlerts.length ? details.riskAlerts.map((item, index) => <li key={`${item}-${index}`}>{item}</li>) : <li className="list-none pl-0">暂无数据</li>}</ul></div>
            <div><h3 className="font-semibold">利好催化</h3><ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-secondary-text">{details.positiveCatalysts.length ? details.positiveCatalysts.map((item, index) => <li key={`${item}-${index}`}>{item}</li>) : <li className="list-none pl-0">暂无数据</li>}</ul></div>
          </section>
          <section><h3 className="font-semibold">关键价格</h3><div className="mt-2 grid grid-cols-2 gap-2 text-sm"><span>支撑位：{details.support || '暂无数据'}</span><span>压力位：{details.resistance || '暂无数据'}</span><span>止损位：{details.stopLoss || '暂无数据'}</span><span>目标位：{details.takeProfit || '暂无数据'}</span></div></section>
          <section><h3 className="font-semibold">技术数据</h3><div className="mt-2 grid grid-cols-2 gap-2 text-sm text-secondary-text sm:grid-cols-4"><span>现价：{details.currentPrice || '暂无数据'}</span><span>MA5：{details.ma5 || '暂无数据'}</span><span>MA10：{details.ma10 || '暂无数据'}</span><span>MA20：{details.ma20 || '暂无数据'}</span><span>均线：{details.trendStatus || '暂无数据'}</span><span>偏离：{details.biasStatus || '暂无数据'}</span><span>量比：{details.volumeRatio || '暂无数据'}</span><span>成交量：{details.volumeStatus || '暂无数据'}</span></div></section>
          <section><h3 className="font-semibold">相关新闻</h3><p className="mt-2 whitespace-pre-wrap text-sm text-secondary-text">{details.news || '暂无数据'}</p></section>
        </div>
        <ReportChatDock report={report} />
      </div>
    </Drawer>
  );
};
