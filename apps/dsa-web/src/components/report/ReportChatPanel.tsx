import { useEffect, useState } from 'react';
import { Send, Square } from 'lucide-react';
import type { AnalysisReport } from '../../types/analysis';
import { useAgentChatStore } from '../../stores/agentChatStore';
import { buildChatFollowUpContext } from '../../utils/chatFollowUp';
import { generateUUID } from '../../utils/uuid';

function getReportSessionId(report: AnalysisReport): string | null {
  const recordId = report.meta.id;
  return typeof recordId === 'number'
    ? `stockmaster-report:${report.meta.stockCode}:${recordId}`
    : null;
}

export function ReportChatPanel({ report }: { report: AnalysisReport }) {
  const [draft, setDraft] = useState('');
  const sessionId = getReportSessionId(report);
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
    await startStream({
      message,
      session_id: sessionId,
      request_id: generateUUID(),
      context: buildChatFollowUpContext(report.meta.stockCode, report.meta.stockName, report),
    });
  };

  return (
    <section
      className="home-panel-card rounded-2xl border border-border/70 bg-card p-4"
      data-testid="report-chat-panel"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">AI 追问</p>
          <h3 className="mt-1 text-lg font-semibold text-foreground">针对本次分析继续提问</h3>
          <p className="mt-1 text-sm text-muted-text">回答会沿用当前股票的报告上下文。</p>
        </div>
        {loading ? <span className="text-sm text-primary">回答中...</span> : null}
      </div>

      <div className="mt-3 max-h-72 space-y-2 overflow-y-auto rounded-xl bg-base/50 p-3 text-sm">
        {messages.length === 0 ? (
          <p className="text-muted-text">可以询问评分依据、趋势判断、风险和关键价格。</p>
        ) : (
          messages.map((message) => (
            <div
              key={message.id}
              className={message.role === 'user' ? 'text-primary' : 'text-foreground'}
            >
              <span className="mr-2 text-[10px] uppercase text-muted-text">
                {message.role === 'user' ? '我' : 'AI'}
              </span>
              <span className="whitespace-pre-wrap">{message.content}</span>
            </div>
          ))
        )}
      </div>

      <div className="mt-3 flex items-center gap-2">
        <input
          value={draft}
          disabled={!sessionId || loading}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void send();
          }}
          placeholder={sessionId ? '针对本次分析提问' : '分析保存后可提问'}
          className="input-surface h-10 min-w-0 flex-1 rounded-xl px-3 text-sm"
        />
        {loading ? (
          <button
            type="button"
            aria-label="停止回答"
            onClick={() => void stopStream()}
            className="btn-secondary h-10 w-10 px-0"
          >
            <Square className="h-4 w-4" />
          </button>
        ) : (
          <button
            type="button"
            aria-label="发送问题"
            onClick={() => void send()}
            className="btn-primary h-10 w-10 px-0"
            disabled={!draft.trim() || !sessionId}
          >
            <Send className="h-4 w-4" />
          </button>
        )}
      </div>
    </section>
  );
}
