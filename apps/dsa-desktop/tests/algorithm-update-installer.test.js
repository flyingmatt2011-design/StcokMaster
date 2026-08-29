const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { validateArchiveEntries, stageBackendCandidate } = require('../algorithm-update/candidateInstaller');

test('archive validator rejects traversal, UI, user-data and duplicate paths', () => {
  const result = validateArchiveEntries([
    { path: 'src/analyzer.py', size: 10, type: 'file' },
    { path: 'templates/report_markdown.j2', size: 10, type: 'file' },
    { path: '../secret.py', size: 10, type: 'file' },
    { path: 'apps/dsa-web/App.tsx', size: 10, type: 'file' },
    { path: 'data/stock_analysis.db', size: 10, type: 'file' },
    { path: 'SRC/ANALYZER.PY', size: 10, type: 'file' },
  ]);
  assert.deepEqual(result.allowedPaths, ['src/analyzer.py', 'templates/report_markdown.j2']);
  assert.equal(result.blockedPaths.length, 4);
});

test('candidate staging copies current runtime and overlays only eligible files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stockmaster-candidate-'));
  const current = path.join(root, 'current');
  const archive = path.join(root, 'archive');
  const staging = path.join(root, 'staging');
  await fs.mkdir(path.join(current, 'src'), { recursive: true });
  await fs.mkdir(path.join(archive, 'src'), { recursive: true });
  await fs.mkdir(path.join(current, 'templates'), { recursive: true });
  await fs.mkdir(path.join(archive, 'templates'), { recursive: true });
  await fs.writeFile(path.join(current, 'main.py'), 'VALUE = 1\n');
  await fs.writeFile(path.join(current, 'server.py'), 'app = object()\n');
  await fs.writeFile(path.join(current, 'src', 'analyzer.py'), 'VALUE = 1\n');
  await fs.writeFile(path.join(current, 'src', 'keep.py'), 'KEEP = 1\n');
  await fs.writeFile(path.join(current, 'templates', 'report_markdown.j2'), 'old template\n');
  await fs.writeFile(path.join(archive, 'src', 'analyzer.py'), 'VALUE = 2\n');
  await fs.writeFile(path.join(archive, 'templates', 'report_markdown.j2'), 'new template\n');
  const result = await stageBackendCandidate({
    currentRoot: current,
    archiveRoot: archive,
    stagingRoot: staging,
    eligiblePaths: ['src/analyzer.py', 'templates/report_markdown.j2'],
  });
  assert.equal(result.ok, true);
  assert.equal(await fs.readFile(path.join(result.candidateRoot, 'server.py'), 'utf8'), 'app = object()\n');
  assert.equal(await fs.readFile(path.join(result.candidateRoot, 'src', 'analyzer.py'), 'utf8'), 'VALUE = 2\n');
  assert.equal(await fs.readFile(path.join(result.candidateRoot, 'src', 'keep.py'), 'utf8'), 'KEEP = 1\n');
  assert.equal(
    await fs.readFile(path.join(result.candidateRoot, 'templates', 'report_markdown.j2'), 'utf8'),
    'new template\n',
  );
});

test('candidate staging excludes UI and user data and applies safe removals', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stockmaster-candidate-filter-'));
  const current = path.join(root, 'current');
  const archive = path.join(root, 'archive');
  const staging = path.join(root, 'staging');
  await fs.mkdir(path.join(current, 'src'), { recursive: true });
  await fs.mkdir(path.join(current, 'apps', 'dsa-web'), { recursive: true });
  await fs.mkdir(path.join(current, 'data'), { recursive: true });
  await fs.mkdir(archive, { recursive: true });
  await fs.writeFile(path.join(current, 'main.py'), 'VALUE = 1\n');
  await fs.writeFile(path.join(current, 'server.py'), 'app = object()\n');
  await fs.writeFile(path.join(current, 'src', 'removed.py'), 'OLD = 1\n');
  await fs.writeFile(path.join(current, 'apps', 'dsa-web', 'App.tsx'), 'ui');
  await fs.writeFile(path.join(current, 'data', 'stock_analysis.db'), 'db');
  await fs.writeFile(path.join(current, '.env'), 'SECRET=value\n');
  const result = await stageBackendCandidate({
    currentRoot: current,
    archiveRoot: archive,
    stagingRoot: staging,
    eligiblePaths: ['src/removed.py'],
    removedPaths: ['src/removed.py'],
  });
  await assert.rejects(fs.access(path.join(result.candidateRoot, 'src', 'removed.py')));
  await assert.rejects(fs.access(path.join(result.candidateRoot, 'apps', 'dsa-web', 'App.tsx')));
  await assert.rejects(fs.access(path.join(result.candidateRoot, 'data', 'stock_analysis.db')));
  await assert.rejects(fs.access(path.join(result.candidateRoot, '.env')));
});

test('candidate staging rejects removal of required backend entries', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stockmaster-candidate-required-'));
  const current = path.join(root, 'current');
  const archive = path.join(root, 'archive');
  const staging = path.join(root, 'staging');
  await fs.mkdir(current, { recursive: true });
  await fs.mkdir(archive, { recursive: true });
  await fs.writeFile(path.join(current, 'main.py'), 'VALUE = 1\n');
  await fs.writeFile(path.join(current, 'server.py'), 'app = object()\n');
  await assert.rejects(
    stageBackendCandidate({
      currentRoot: current,
      archiveRoot: archive,
      stagingRoot: staging,
      eligiblePaths: ['server.py'],
      removedPaths: ['server.py'],
    }),
    /cannot remove required runtime entry: server\.py/,
  );
});

test('candidate staging merges upstream changes while keeping StockMaster conflicts', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stockmaster-candidate-merge-'));
  const current = path.join(root, 'current');
  const archive = path.join(root, 'archive');
  const local = path.join(root, 'local');
  const baseline = path.join(root, 'baseline');
  const upstream = path.join(root, 'upstream');
  for (const directory of [current, archive, local, baseline, upstream]) {
    await fs.mkdir(path.join(directory, 'src'), { recursive: true });
  }
  await fs.writeFile(path.join(current, 'main.py'), 'VALUE = 1\n');
  await fs.writeFile(path.join(current, 'server.py'), 'app = object()\n');
  await fs.writeFile(path.join(current, 'src', 'config.py'), 'decision = "old-runtime"\n');
  await fs.writeFile(path.join(archive, 'src', 'config.py'), 'decision = "upstream"\n');
  await fs.writeFile(path.join(local, 'src', 'config.py'), 'decision = "stockmaster"\n');
  await fs.writeFile(path.join(baseline, 'src', 'config.py'), 'decision = "base"\n');
  await fs.writeFile(path.join(upstream, 'src', 'config.py'), 'decision = "upstream"\n');

  const result = await stageBackendCandidate({
    currentRoot: current,
    archiveRoot: archive,
    stagingRoot: path.join(root, 'staging'),
    eligiblePaths: ['src/config.py'],
    localRoot: local,
    localOverlayPaths: ['src/config.py'],
    localBaselineRoot: baseline,
    localUpstreamRoot: upstream,
    localChangeStatuses: { 'src/config.py': 'modified' },
    localBaselineCommit: 'a'.repeat(40),
    candidateCommit: 'b'.repeat(40),
  });

  assert.equal(await fs.readFile(path.join(result.candidateRoot, 'src', 'config.py'), 'utf8'), 'decision = "stockmaster"\n');
  assert.deepEqual(result.mergeSummary.mergedPaths, ['src/config.py']);
  assert.deepEqual(result.mergeSummary.conflictPaths, ['src/config.py']);
  assert.equal(
    await fs.readFile(path.join(result.candidateRoot, '.stockmaster-merge', 'upstream', 'src', 'config.py'), 'utf8'),
    'decision = "upstream"\n',
  );
});

test('upstream deletion is accepted only when StockMaster did not change the file', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stockmaster-candidate-remove-'));
  const current = path.join(root, 'current');
  const archive = path.join(root, 'archive');
  const local = path.join(root, 'local');
  const baseline = path.join(root, 'baseline');
  for (const directory of [current, archive, local, baseline]) {
    await fs.mkdir(path.join(directory, 'src'), { recursive: true });
  }
  await fs.writeFile(path.join(current, 'main.py'), 'VALUE = 1\n');
  await fs.writeFile(path.join(current, 'server.py'), 'app = object()\n');
  await fs.writeFile(path.join(current, 'src', 'config.py'), 'VALUE = "base"\n');
  await fs.writeFile(path.join(local, 'src', 'config.py'), 'VALUE = "stockmaster"\n');
  await fs.writeFile(path.join(baseline, 'src', 'config.py'), 'VALUE = "base"\n');

  const result = await stageBackendCandidate({
    currentRoot: current,
    archiveRoot: archive,
    stagingRoot: path.join(root, 'staging'),
    eligiblePaths: ['src/config.py'],
    removedPaths: ['src/config.py'],
    localRoot: local,
    localOverlayPaths: ['src/config.py'],
    localBaselineRoot: baseline,
    localUpstreamRoot: path.join(root, 'upstream'),
    localChangeStatuses: { 'src/config.py': 'removed' },
  });
  assert.equal(await fs.readFile(path.join(result.candidateRoot, 'src', 'config.py'), 'utf8'), 'VALUE = "stockmaster"\n');
  assert.deepEqual(result.mergeSummary.conflictPaths, ['src/config.py']);
});

test('upstream deletion removes an unchanged StockMaster overlay', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stockmaster-candidate-remove-clean-'));
  const current = path.join(root, 'current');
  const archive = path.join(root, 'archive');
  const local = path.join(root, 'local');
  const baseline = path.join(root, 'baseline');
  for (const directory of [current, archive, local, baseline]) {
    await fs.mkdir(path.join(directory, 'src'), { recursive: true });
  }
  await fs.writeFile(path.join(current, 'main.py'), 'VALUE = 1\n');
  await fs.writeFile(path.join(current, 'server.py'), 'app = object()\n');
  await fs.writeFile(path.join(current, 'src', 'config.py'), 'VALUE = "base"\n');
  await fs.writeFile(path.join(local, 'src', 'config.py'), 'VALUE = "base"\n');
  await fs.writeFile(path.join(baseline, 'src', 'config.py'), 'VALUE = "base"\n');

  const result = await stageBackendCandidate({
    currentRoot: current,
    archiveRoot: archive,
    stagingRoot: path.join(root, 'staging'),
    eligiblePaths: ['src/config.py'],
    removedPaths: ['src/config.py'],
    localRoot: local,
    localOverlayPaths: ['src/config.py'],
    localBaselineRoot: baseline,
    localUpstreamRoot: path.join(root, 'upstream'),
    localChangeStatuses: { 'src/config.py': 'removed' },
  });
  await assert.rejects(fs.access(path.join(result.candidateRoot, 'src', 'config.py')));
  assert.deepEqual(result.mergeSummary.acceptedRemovalPaths, ['src/config.py']);
});

test('upstream rename moves the merged StockMaster implementation to the new path', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stockmaster-candidate-rename-'));
  const current = path.join(root, 'current');
  const archive = path.join(root, 'archive');
  const local = path.join(root, 'local');
  const baseline = path.join(root, 'baseline');
  const upstream = path.join(root, 'upstream');
  for (const directory of [current, archive, local, baseline, upstream]) {
    await fs.mkdir(path.join(directory, 'src'), { recursive: true });
  }
  await fs.writeFile(path.join(current, 'main.py'), 'VALUE = 1\n');
  await fs.writeFile(path.join(current, 'server.py'), 'app = object()\n');
  await fs.writeFile(path.join(current, 'src', 'old.py'), 'choice = "runtime"\n');
  await fs.writeFile(path.join(archive, 'src', 'new.py'), 'choice = "upstream"\n');
  await fs.writeFile(path.join(local, 'src', 'old.py'), 'choice = "stockmaster"\n');
  await fs.writeFile(path.join(baseline, 'src', 'old.py'), 'choice = "base"\n');
  await fs.writeFile(path.join(upstream, 'src', 'new.py'), 'choice = "upstream"\n');

  const result = await stageBackendCandidate({
    currentRoot: current,
    archiveRoot: archive,
    stagingRoot: path.join(root, 'staging'),
    eligiblePaths: ['src/new.py'],
    removedPaths: ['src/old.py'],
    localRoot: local,
    localOverlayPaths: ['src/old.py'],
    localBaselineRoot: baseline,
    localUpstreamRoot: upstream,
    localChangeStatuses: { 'src/old.py': 'renamed' },
    localRenameTargets: { 'src/old.py': 'src/new.py' },
  });
  await assert.rejects(fs.access(path.join(result.candidateRoot, 'src', 'old.py')));
  assert.equal(await fs.readFile(path.join(result.candidateRoot, 'src', 'new.py'), 'utf8'), 'choice = "stockmaster"\n');
  assert.deepEqual(result.mergeSummary.conflictPaths, ['src/old.py']);
});
