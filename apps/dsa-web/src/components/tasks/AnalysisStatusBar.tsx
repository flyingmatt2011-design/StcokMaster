import type React from 'react';
import { useEffect, useState } from 'react';
import { Activity, Loader2 } from 'lucide-react';
import { StatusDot } from '../common';
import { useUiLanguage } from '../../contexts/UiLanguageContext';
import type { TaskInfo } from '../../types/analysis';

export interface AnalysisBatchStatus {
  variant: 'success' | 'warning' | 'danger';
  message: string;
}

interface AnalysisStatusBarProps {
  tasks: TaskInfo[];
  batchStatus?: AnalysisBatchStatus | null;
  className?: string;
}

const statusToneClass: Record<AnalysisBatchStatus['variant'], string> = {
  success: 'border-success/30 bg-success/10 text-success',
  warning: 'border-warning/30 bg-warning/10 text-warning',
  danger: 'border-danger/30 bg-danger/10 text-danger',
};

export const AnalysisStatusBar: React.FC<AnalysisStatusBarProps> = ({ tasks, batchStatus = null, className = '' }) => {
  const { language, t } = useUiLanguage();
  const [now, setNow] = useState(() => Date.now());
  const activeTasks = tasks.filter((task) => (
    task.status === 'pending' || task.status === 'processing' || task.status === 'cancel_requested'
  ));
  const processingTasks = activeTasks.filter((task) => task.status === 'processing');
  const queuedCount = activeTasks.filter((task) => task.status === 'pending').length;
  const averageProgress = processingTasks.length > 0
    ? Math.round(processingTasks.reduce((total, task) => total + Math.max(0, Math.min(100, task.progress || 0)), 0) / processingTasks.length)
    : 0;

  useEffect(() => {
    if (activeTasks.length === 0) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [activeTasks.length]);

  const stageLabels: Record<string, string> = language === 'en'
    ? { queued: 'Queued', market_data: 'Market data', indicators: 'Indicators', news: 'News', llm: 'AI analysis', report: 'Report', stopping: 'Stopping' }
    : { queued: '等待执行', market_data: '获取行情', indicators: '技术指标', news: '新闻分析', llm: 'AI 分析', report: '生成报告', stopping: '本只完成后停止' };
  const formatElapsed = (task: TaskInfo) => {
    const started = task.startedAt ? Date.parse(task.startedAt) : Number.NaN;
    const seconds = Number.isFinite(started)
      ? Math.max(0, Math.floor((now - started) / 1000))
      : Math.max(0, task.elapsedSeconds || 0);
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;
    return `${minutes}:${String(remainder).padStart(2, '0')}`;
  };

  if (activeTasks.length === 0 && !batchStatus) return null;

  return (
    <div
      className={`stockmaster-analysis-status mx-3 mt-3 flex min-w-0 flex-col gap-2 rounded-xl border border-subtle bg-card/75 px-3 py-2.5 shadow-sm sm:mx-4 lg:mx-0 ${className}`}
      data-testid="home-analysis-status-bar"
      role="status"
      aria-live="polite"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span className="inline-flex shrink-0 items-center gap-1.5 font-medium text-foreground">
          {activeTasks.length > 0 ? <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" aria-hidden="true" /> : <Activity className="h-3.5 w-3.5 text-primary" aria-hidden="true" />}
          {t('home.analysisStatusTitle')}
        </span>
        {processingTasks.length > 0 ? (
          <span className="inline-flex items-center gap-1 text-secondary-text">
            <StatusDot tone="info" pulse className="h-1.5 w-1.5" />
            {t('home.analysisStatusRunning', { count: processingTasks.length })}
          </span>
        ) : null}
        {queuedCount > 0 ? <span className="text-muted-text">{t('home.analysisStatusQueued', { count: queuedCount })}</span> : null}
        {processingTasks.length > 0 ? <span className="text-muted-text">{t('home.analysisStatusProgress', { progress: averageProgress })}</span> : null}
        {batchStatus ? (
          <>
            <span
              className={`rounded-md border px-2 py-0.5 ${statusToneClass[batchStatus.variant]}`}
              data-testid="analysis-status-batch"
            >
              {batchStatus.variant === 'success' ? t('common.success') : batchStatus.variant === 'danger' ? t('common.failure') : t('common.processing')}
            </span>
            <span className="min-w-0 flex-1 truncate text-secondary-text" aria-label={batchStatus.message}>{batchStatus.message}</span>
          </>
        ) : null}
      </div>
      {processingTasks.length > 0 ? (
        <div className="flex min-w-0 items-center gap-2">
          <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-base/80" aria-hidden="true">
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out"
              data-testid="analysis-status-progress"
              style={{ width: `${averageProgress}%` }}
            />
          </div>
          <span className="shrink-0 text-[11px] tabular-nums text-muted-text">{averageProgress}%</span>
        </div>
      ) : null}
      {activeTasks.length > 0 ? (
        <div className="grid min-w-0 gap-1.5 sm:grid-cols-2 xl:grid-cols-3" data-testid="analysis-status-task-list">
          {activeTasks.slice(0, 3).map((task) => (
            <div key={task.taskId} className="flex min-w-0 items-center gap-2 rounded-lg border border-subtle bg-base/45 px-2.5 py-1.5 text-[11px]">
              <span className="shrink-0 font-mono font-semibold text-foreground">{task.stockName || task.stockCode}</span>
              <span className="min-w-0 flex-1 truncate text-secondary-text" aria-label={task.message}>
                {stageLabels[task.stage || ''] || task.message || stageLabels.queued}
              </span>
              {task.recovered ? <span className="shrink-0 rounded bg-warning/12 px-1.5 py-0.5 text-warning">{language === 'en' ? 'Restored' : '已恢复'}</span> : null}
              <span className="shrink-0 font-mono tabular-nums text-muted-text">{formatElapsed(task)}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
};

export default AnalysisStatusBar;
