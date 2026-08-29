const FAILURE_BACKOFF_MS = Object.freeze([60_000, 120_000, 300_000, 600_000, 1_800_000]);

function createAlgorithmUpdateMonitor({
  currentCommit,
  appliedCommit = '',
  lastAppliedAt = '',
  mergePolicy = '',
  localBaselineCommit = '',
  localMergedPaths = [],
  localConflictPaths = [],
  intervalMs = 60_000,
  fetchCompare,
  classify,
  onAvailable,
  onStateChanged,
  now = () => Date.now(),
  setTimer = (fn, delay) => setTimeout(fn, delay),
  clearTimer = (timer) => clearTimeout(timer),
} = {}) {
  if (typeof fetchCompare !== 'function' || typeof classify !== 'function') {
    throw new TypeError('fetchCompare and classify are required');
  }
  let timer = null;
  let inFlight = null;
  let stopped = false;
  const state = {
    status: 'idle',
    currentCommit: String(currentCommit || ''),
    lastSeenCommit: '',
    lastCheckedAt: '',
    consecutiveFailures: 0,
    nextCheckAt: '',
    error: '',
    algorithmUpdateAvailable: false,
    candidateCommit: '',
    candidatePaths: [],
    candidateDependencyPaths: [],
    candidateRemovedPaths: [],
    syncStatus: 'idle',
    syncMessage: '',
    appliedCommit: String(appliedCommit || ''),
    lastAppliedAt: String(lastAppliedAt || ''),
    mergePolicy: String(mergePolicy || ''),
    localBaselineCommit: String(localBaselineCommit || ''),
    localMergedPaths: Array.isArray(localMergedPaths) ? [...localMergedPaths] : [],
    localConflictPaths: Array.isArray(localConflictPaths) ? [...localConflictPaths] : [],
  };

  function emitState() {
    onStateChanged?.({ ...state });
  }

  function schedule(delay) {
    if (stopped) return;
    if (timer) clearTimer(timer);
    state.nextCheckAt = new Date(now() + delay).toISOString();
    emitState();
    timer = setTimer(() => {
      timer = null;
      void checkNow();
    }, delay);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  async function runCheck() {
    state.status = 'checking';
    state.lastCheckedAt = new Date(now()).toISOString();
    emitState();
    try {
      const result = await fetchCompare({ currentCommit: state.currentCommit });
      const headCommit = String(result?.headCommit || '');
      state.lastSeenCommit = headCommit;
      state.consecutiveFailures = 0;
      state.error = '';
      state.status = 'idle';
      const classification = classify(result?.changedPaths || []);
      const hasAlgorithmUpdate = Boolean(
        headCommit
        && headCommit !== state.currentCommit
        && ['backend_algorithm', 'mixed'].includes(classification.kind)
        && classification.eligiblePaths?.length,
      );
      state.algorithmUpdateAvailable = hasAlgorithmUpdate;
      state.candidateCommit = hasAlgorithmUpdate ? headCommit : '';
      state.candidatePaths = hasAlgorithmUpdate ? [...classification.eligiblePaths] : [];
      state.candidateDependencyPaths = hasAlgorithmUpdate ? [...(classification.dependencyPaths || [])] : [];
      const removed = new Set((result?.changedFiles || [])
        .filter((file) => file?.status === 'removed')
        .map((file) => file.path));
      const renamedPreviousPaths = [];
      for (const file of result?.changedFiles || []) {
        if (file?.status === 'renamed' && file.previousPath) renamedPreviousPaths.push(file.previousPath);
      }
      const renamedPreviousClassification = classify(renamedPreviousPaths);
      state.candidateRemovedPaths = hasAlgorithmUpdate
        ? [...new Set([
          ...[...classification.eligiblePaths, ...(classification.dependencyPaths || [])]
            .filter((file) => removed.has(file)),
          ...(renamedPreviousClassification.eligiblePaths || []),
          ...(renamedPreviousClassification.dependencyPaths || []),
        ])]
        : [];
      emitState();
      if (hasAlgorithmUpdate) {
        onAvailable?.({ headCommit, changedPaths: result?.changedPaths || [], classification });
      }
      schedule(intervalMs);
      return { headCommit, classification };
    } catch (error) {
      state.consecutiveFailures += 1;
      state.status = 'error';
      state.error = error instanceof Error ? error.message : String(error);
      emitState();
      const index = Math.min(state.consecutiveFailures - 1, FAILURE_BACKOFF_MS.length - 1);
      schedule(FAILURE_BACKOFF_MS[index]);
      throw error;
    } finally {
      inFlight = null;
    }
  }

  function checkNow() {
    if (inFlight) return inFlight;
    inFlight = runCheck();
    return inFlight;
  }

  function start() {
    stopped = false;
    return checkNow();
  }

  function stop() {
    stopped = true;
    if (timer) clearTimer(timer);
    timer = null;
    state.nextCheckAt = '';
    state.status = 'stopped';
    emitState();
  }

  function setSyncState(patch = {}) {
    const allowed = ['syncStatus', 'syncMessage'];
    for (const key of allowed) {
      if (Object.hasOwn(patch, key)) state[key] = String(patch[key] || '');
    }
    emitState();
    return { ...state };
  }

  function markApplied(commit, details = {}) {
    const normalized = String(commit || '');
    if (!/^[0-9a-f]{40}$/i.test(normalized)) throw new Error('A full applied commit SHA is required');
    state.currentCommit = normalized;
    state.lastSeenCommit = normalized;
    state.algorithmUpdateAvailable = false;
    state.candidateCommit = '';
    state.candidatePaths = [];
    state.candidateDependencyPaths = [];
    state.candidateRemovedPaths = [];
    state.syncStatus = 'succeeded';
    const mergeSummary = details.mergeSummary || {};
    state.mergePolicy = String(mergeSummary.policy || state.mergePolicy || '');
    state.localBaselineCommit = String(details.localBaselineCommit || state.localBaselineCommit || '');
    state.localMergedPaths = Array.isArray(mergeSummary.mergedPaths) ? [...mergeSummary.mergedPaths] : [];
    state.localConflictPaths = Array.isArray(mergeSummary.conflictPaths) ? [...mergeSummary.conflictPaths] : [];
    state.syncMessage = state.mergePolicy === 'three-way-local-wins'
      ? `后端算法已同步并通过健康检查；三方合并 ${state.localMergedPaths.length} 个文件，StockMaster 优先解决 ${state.localConflictPaths.length} 个冲突`
      : '后端分析算法已同步并通过健康检查';
    state.appliedCommit = normalized;
    state.lastAppliedAt = new Date(now()).toISOString();
    emitState();
    return { ...state };
  }

  return {
    start,
    stop,
    checkNow,
    setSyncState,
    markApplied,
    getState: () => ({ ...state }),
  };
}

module.exports = { createAlgorithmUpdateMonitor, FAILURE_BACKOFF_MS };
