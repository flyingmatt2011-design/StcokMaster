import type { AnalyzeAsyncResponse, TaskStatus } from '../types/analysis';

export interface WatchlistBatchAnalysisResult {
  acceptedCount: number;
  duplicateCount: number;
  processedCount: number;
  stopped: boolean;
  failedCount: number;
  failureReason?: string;
}

interface WatchlistBatchAnalysisOptions {
  stockCodes: string[];
  submit: (stockCode: string) => Promise<AnalyzeAsyncResponse>;
  waitForTask: (taskId: string) => Promise<TaskStatus>;
  shouldStop: () => boolean;
  maxConcurrency?: number;
  onStockSubmitted?: (counts: { acceptedCount: number; duplicateCount: number }) => void;
  onStockSettled?: (stockCode: string, task: TaskStatus) => void;
}

const TERMINAL_TASK_STATUSES = new Set<TaskStatus['status']>(['completed', 'failed', 'cancelled']);

export async function waitForWatchlistTask(
  taskId: string,
  getStatus: (taskId: string) => Promise<TaskStatus>,
  pollIntervalMs = 1000,
): Promise<TaskStatus> {
  while (true) {
    const task = await getStatus(taskId);
    if (TERMINAL_TASK_STATUSES.has(task.status)) {
      return task;
    }
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, pollIntervalMs);
    });
  }
}

function getTaskReference(response: AnalyzeAsyncResponse): {
  taskId: string;
  acceptedCount: number;
  duplicateCount: number;
} {
  if ('accepted' in response) {
    const accepted = response.accepted[0];
    const duplicate = response.duplicates[0];
    if (accepted) {
      return {
        taskId: accepted.taskId,
        acceptedCount: response.accepted.length,
        duplicateCount: response.duplicates.length,
      };
    }
    if (duplicate) {
      return {
        taskId: duplicate.existingTaskId,
        acceptedCount: response.accepted.length,
        duplicateCount: response.duplicates.length,
      };
    }
    throw new Error('分析请求未返回可跟踪的任务');
  }

  return {
    taskId: response.taskId,
    acceptedCount: 1,
    duplicateCount: 0,
  };
}

export async function runWatchlistBatchAnalysis({
  stockCodes,
  submit,
  waitForTask,
  shouldStop,
  maxConcurrency = 1,
  onStockSubmitted,
  onStockSettled,
}: WatchlistBatchAnalysisOptions): Promise<WatchlistBatchAnalysisResult> {
  let acceptedCount = 0;
  let duplicateCount = 0;
  let processedCount = 0;
  let failedCount = 0;
  let failureReason: string | undefined;
  let nextIndex = 0;
  let stopObserved = false;
  let schedulingAborted = false;
  let submissionError: unknown;

  const workerLimit = Math.min(
    stockCodes.length,
    Math.max(1, Math.floor(Number.isFinite(maxConcurrency) ? maxConcurrency : 1)),
  );

  const runWorker = async () => {
    while (true) {
      if (schedulingAborted) {
        return;
      }
      if (shouldStop()) {
        stopObserved = true;
        return;
      }

      const index = nextIndex;
      if (index >= stockCodes.length) {
        return;
      }
      nextIndex += 1;
      const stockCode = stockCodes[index];

      let reference: ReturnType<typeof getTaskReference>;
      try {
        const response = await submit(stockCode);
        reference = getTaskReference(response);
      } catch (error) {
        if (!schedulingAborted) {
          submissionError = error;
        }
        schedulingAborted = true;
        return;
      }
      acceptedCount += reference.acceptedCount;
      duplicateCount += reference.duplicateCount;
      onStockSubmitted?.({ acceptedCount, duplicateCount });

      let task: TaskStatus;
      try {
        task = await waitForTask(reference.taskId);
      } catch (error) {
        if (!schedulingAborted) {
          submissionError = error;
        }
        schedulingAborted = true;
        return;
      }
      processedCount += 1;
      if (task.status === 'failed' || task.status === 'cancelled') {
        failedCount += 1;
        failureReason ||= task.error || (task.status === 'cancelled' ? '任务已取消' : '分析失败');
      }
      onStockSettled?.(stockCode, task);

      if (shouldStop()) {
        stopObserved = true;
        return;
      }
    }
  };

  await Promise.all(Array.from({ length: workerLimit }, () => runWorker()));

  if (schedulingAborted) {
    throw submissionError;
  }

  return {
    acceptedCount,
    duplicateCount,
    processedCount,
    stopped: stopObserved || nextIndex < stockCodes.length,
    failedCount,
    failureReason,
  };
}
