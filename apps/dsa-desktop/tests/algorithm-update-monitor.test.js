const test = require('node:test');
const assert = require('node:assert/strict');
const { createAlgorithmUpdateMonitor } = require('../algorithm-update/monitor');

test('monitor checks immediately, prevents overlap, and offers backend updates only', async () => {
  let now = 1000;
  const timers = [];
  let resolveFirst;
  const fetchCompare = () => new Promise((resolve) => { resolveFirst = resolve; });
  const offered = [];
  const monitor = createAlgorithmUpdateMonitor({
    currentCommit: 'base',
    intervalMs: 60_000,
    fetchCompare,
    classify: () => ({ kind: 'backend_algorithm', eligiblePaths: ['src/analyzer.py'] }),
    onAvailable: (value) => offered.push(value),
    now: () => now,
    setTimer: (fn, delay) => { timers.push({ fn, delay }); return timers.length; },
    clearTimer: () => undefined,
  });
  const first = monitor.checkNow();
  const second = monitor.checkNow();
  assert.equal(second, first);
  resolveFirst({ headCommit: 'candidate', changedPaths: ['src/analyzer.py'] });
  await first;
  assert.equal(offered.length, 1);
  assert.equal(monitor.getState().algorithmUpdateAvailable, true);
  assert.equal(monitor.getState().candidateCommit, 'candidate');
  assert.deepEqual(monitor.getState().candidatePaths, ['src/analyzer.py']);
  assert.equal(timers[0].delay, 60_000);
  monitor.stop();
});

test('monitor backs off after failures and suppresses UI-only changes', async () => {
  const timers = [];
  const offered = [];
  const monitor = createAlgorithmUpdateMonitor({
    currentCommit: 'base',
    intervalMs: 60_000,
    fetchCompare: async () => ({ headCommit: 'ui', changedPaths: ['apps/dsa-web/src/App.tsx'] }),
    classify: () => ({ kind: 'ui_only', eligiblePaths: [] }),
    onAvailable: (value) => offered.push(value),
    setTimer: (fn, delay) => { timers.push({ fn, delay }); return timers.length; },
    clearTimer: () => undefined,
  });
  await monitor.checkNow();
  assert.equal(offered.length, 0);
  assert.equal(monitor.getState().lastSeenCommit, 'ui');
  assert.equal(monitor.getState().algorithmUpdateAvailable, false);
  assert.equal(monitor.getState().candidateCommit, '');
  monitor.stop();
});

test('monitor emits sanitized state changes for the settings UI', async () => {
  const states = [];
  const monitor = createAlgorithmUpdateMonitor({
    currentCommit: 'base',
    fetchCompare: async () => ({ headCommit: 'ui', changedPaths: [] }),
    classify: () => ({ kind: 'irrelevant', eligiblePaths: [] }),
    onStateChanged: (state) => states.push(state),
    setTimer: () => ({ unref() {} }),
    clearTimer: () => undefined,
  });
  await monitor.checkNow();
  assert.ok(states.some((state) => state.status === 'checking'));
  assert.ok(states.some((state) => state.status === 'idle'));
  monitor.stop();
  assert.equal(states.at(-1).status, 'stopped');
});

test('monitor keeps the persisted applied runtime visible after restart', () => {
  const monitor = createAlgorithmUpdateMonitor({
    currentCommit: 'a'.repeat(40),
    appliedCommit: 'a'.repeat(40),
    lastAppliedAt: '2026-08-19T06:00:00.000Z',
    fetchCompare: async () => ({ headCommit: '', changedPaths: [] }),
    classify: () => ({ kind: 'irrelevant', eligiblePaths: [], dependencyPaths: [] }),
    setTimer: () => ({ unref() {} }),
    clearTimer: () => undefined,
  });
  assert.equal(monitor.getState().appliedCommit, 'a'.repeat(40));
  assert.equal(monitor.getState().lastAppliedAt, '2026-08-19T06:00:00.000Z');
});

test('monitor records the local-wins merge result after activation', () => {
  const monitor = createAlgorithmUpdateMonitor({
    currentCommit: 'a'.repeat(40),
    localProtectedPaths: ['src/core/pipeline.py', 'src/services/kronos_forecast_service.py'],
    fetchCompare: async () => ({ headCommit: '', changedPaths: [] }),
    classify: () => ({ kind: 'irrelevant', eligiblePaths: [], dependencyPaths: [] }),
  });
  const state = monitor.markApplied('b'.repeat(40), {
    localBaselineCommit: 'a'.repeat(40),
    mergeSummary: {
      policy: 'three-way-local-wins',
      mergedPaths: ['src/config.py'],
      conflictPaths: ['src/config.py'],
    },
  });
  assert.equal(state.mergePolicy, 'three-way-local-wins');
  assert.equal(state.localProtectionPathCount, 2);
  assert.deepEqual(state.localConflictPaths, ['src/config.py']);
  assert.match(state.syncMessage, /StockMaster 优先解决 1 个冲突/);
});

test('monitor records the previous path of an eligible upstream rename for removal', async () => {
  const monitor = createAlgorithmUpdateMonitor({
    currentCommit: 'a'.repeat(40),
    fetchCompare: async () => ({
      headCommit: 'b'.repeat(40),
      changedPaths: ['src/new.py'],
      changedFiles: [{ path: 'src/new.py', previousPath: 'src/old.py', status: 'renamed' }],
    }),
    classify: (paths) => ({
      kind: 'backend_algorithm',
      eligiblePaths: [...paths],
      dependencyPaths: [],
    }),
    setTimer: () => ({ unref() {} }),
    clearTimer: () => undefined,
  });
  await monitor.checkNow();
  assert.deepEqual(monitor.getState().candidateRemovedPaths, ['src/old.py']);
  monitor.stop();
});
