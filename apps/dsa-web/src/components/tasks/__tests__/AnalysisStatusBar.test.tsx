import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { UiLanguageProvider } from '../../../contexts/UiLanguageContext';
import type { TaskInfo } from '../../../types/analysis';
import { AnalysisStatusBar } from '../AnalysisStatusBar';

const task = (overrides: Partial<TaskInfo> = {}): TaskInfo => ({
  taskId: 'task-1',
  stockCode: '600519',
  status: 'processing',
  progress: 40,
  reportType: 'detailed',
  createdAt: '2026-03-19T09:00:00+08:00',
  stage: 'indicators',
  ...overrides,
});

function renderBar(tasks: TaskInfo[], batchStatus?: { variant: 'success' | 'warning' | 'danger'; message: string } | null) {
  return render(
    <UiLanguageProvider>
      <AnalysisStatusBar tasks={tasks} batchStatus={batchStatus} />
    </UiLanguageProvider>,
  );
}

describe('AnalysisStatusBar', () => {
  it('shows active task counts and average progress', () => {
    renderBar([task(), task({ taskId: 'task-2', status: 'pending', progress: 0 })]);

    expect(screen.getByTestId('home-analysis-status-bar')).toBeInTheDocument();
    expect(screen.getByTestId('analysis-status-progress')).toHaveStyle({ width: '40%' });
    expect(screen.getByText('40%')).toBeInTheDocument();
    expect(screen.getByTestId('analysis-status-task-list')).toHaveTextContent(/技术指标|Indicators/);
  });

  it('marks a task restored after a desktop restart', () => {
    renderBar([task({ recovered: true, stage: 'news', message: '正在分析新闻' })]);
    expect(screen.getByText(/已恢复|Restored/)).toBeInTheDocument();
    expect(screen.getByText(/新闻分析|News/)).toBeInTheDocument();
  });

  it('also remains visible for a completed batch submission message', () => {
    renderBar([], { variant: 'success', message: 'Submitted 2 task(s)' });

    expect(screen.getByTestId('analysis-status-batch')).toBeInTheDocument();
  });

  it('stays hidden when there are no active tasks or batch messages', () => {
    renderBar([task({ status: 'completed', progress: 100 })]);

    expect(screen.queryByTestId('home-analysis-status-bar')).not.toBeInTheDocument();
  });
});
