import { describe, expect, it, vi } from 'vitest';
import type { AnalyzeAsyncResponse, TaskStatus } from '../types/analysis';
import { runWatchlistBatchAnalysis, waitForWatchlistTask } from './watchlistBatchAnalysis';

describe('runWatchlistBatchAnalysis', () => {
  it('waits for the current stock and stops before submitting the next one', async () => {
    const submitted: string[] = [];
    let stopRequested = false;
    const waitForTask = vi.fn(async (taskId: string): Promise<TaskStatus> => {
      if (taskId === 'task-A') {
        stopRequested = true;
      }
      return {
        taskId,
        status: 'completed',
      };
    });

    const result = await runWatchlistBatchAnalysis({
      stockCodes: ['A', 'B'],
      submit: async (stockCode): Promise<AnalyzeAsyncResponse> => {
        submitted.push(stockCode);
        return { taskId: `task-${stockCode}`, status: 'pending' };
      },
      waitForTask,
      shouldStop: () => stopRequested,
    });

    expect(submitted).toEqual(['A']);
    expect(waitForTask).toHaveBeenCalledWith('task-A');
    expect(result).toMatchObject({ acceptedCount: 1, duplicateCount: 0, stopped: true });
  });

  it('polls until a task reaches a terminal status', async () => {
    const getStatus = vi
      .fn<(_: string) => Promise<TaskStatus>>()
      .mockResolvedValueOnce({ taskId: 'task-A', status: 'processing' })
      .mockResolvedValueOnce({ taskId: 'task-A', status: 'completed' });

    const result = await waitForWatchlistTask('task-A', getStatus, 0);

    expect(result.status).toBe('completed');
    expect(getStatus).toHaveBeenCalledTimes(2);
  });

  it('reports failed stocks without changing stop-after-current sequencing', async () => {
    const result = await runWatchlistBatchAnalysis({
      stockCodes: ['A', 'B'],
      submit: async (stockCode) => ({ taskId: `task-${stockCode}`, status: 'pending' }),
      waitForTask: async (taskId) => ({ taskId, status: taskId.endsWith('A') ? 'failed' : 'completed', error: 'provider timeout' }),
      shouldStop: () => false,
    });
    expect(result).toMatchObject({ processedCount: 2, failedCount: 1, stopped: false });
  });

  it('runs up to the configured number of stocks in parallel', async () => {
    const submitted: string[] = [];
    const releases = new Map<string, () => void>();
    let activeCount = 0;
    let peakActiveCount = 0;

    const run = runWatchlistBatchAnalysis({
      stockCodes: ['A', 'B', 'C'],
      maxConcurrency: 2,
      submit: async (stockCode) => {
        submitted.push(stockCode);
        return { taskId: `task-${stockCode}`, status: 'pending' as const };
      },
      waitForTask: (taskId) => new Promise<TaskStatus>((resolve) => {
        activeCount += 1;
        peakActiveCount = Math.max(peakActiveCount, activeCount);
        releases.set(taskId, () => {
          activeCount -= 1;
          resolve({ taskId, status: 'completed' });
        });
      }),
      shouldStop: () => false,
    });

    await vi.waitFor(() => expect(submitted).toEqual(['A', 'B']));
    expect(peakActiveCount).toBe(2);

    releases.get('task-A')?.();
    await vi.waitFor(() => expect(submitted).toEqual(['A', 'B', 'C']));
    releases.get('task-B')?.();
    releases.get('task-C')?.();

    await expect(run).resolves.toMatchObject({
      acceptedCount: 3,
      processedCount: 3,
      stopped: false,
    });
    expect(peakActiveCount).toBe(2);
  });

  it('finishes active parallel stocks and stops before starting another one', async () => {
    const submitted: string[] = [];
    const releases = new Map<string, () => void>();
    let stopRequested = false;

    const run = runWatchlistBatchAnalysis({
      stockCodes: ['A', 'B', 'C'],
      maxConcurrency: 2,
      submit: async (stockCode) => {
        submitted.push(stockCode);
        return { taskId: `task-${stockCode}`, status: 'pending' as const };
      },
      waitForTask: (taskId) => new Promise<TaskStatus>((resolve) => {
        releases.set(taskId, () => resolve({ taskId, status: 'completed' }));
      }),
      shouldStop: () => stopRequested,
    });

    await vi.waitFor(() => expect(submitted).toEqual(['A', 'B']));
    stopRequested = true;
    releases.get('task-A')?.();
    releases.get('task-B')?.();

    await expect(run).resolves.toMatchObject({
      acceptedCount: 2,
      processedCount: 2,
      stopped: true,
    });
    expect(submitted).toEqual(['A', 'B']);
  });
});
