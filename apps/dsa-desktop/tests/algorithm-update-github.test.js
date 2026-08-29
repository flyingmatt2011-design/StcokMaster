const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { fetchUpstreamCompare, downloadUpstreamFiles } = require('../algorithm-update/githubClient');

test('github client compares the pinned upstream repository with a full SHA', async () => {
  let requested;
  const result = await fetchUpstreamCompare({
    currentCommit: 'a'.repeat(40),
    requestJson: async (url, options) => {
      requested = { url, options };
      return { status: 200, body: { head: { sha: 'b'.repeat(40) }, files: [{ filename: 'src/analyzer.py', status: 'modified' }] } };
    },
  });
  assert.match(requested.url, /repos\/ZhuLinsen\/daily_stock_analysis\/compare\//);
  assert.equal(requested.options.headers['User-Agent'], 'StockMaster-algorithm-updater');
  assert.equal(result.headCommit, 'b'.repeat(40));
  assert.deepEqual(result.changedPaths, ['src/analyzer.py']);
  assert.deepEqual(result.changedFiles, [{ path: 'src/analyzer.py', status: 'modified' }]);
});

test('github client downloads exact-commit backend files into staging', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stockmaster-download-'));
  let requestedUrl = '';
  const result = await downloadUpstreamFiles({
    commit: 'b'.repeat(40),
    paths: ['src/analyzer.py'],
    destinationRoot: root,
    download: async (url) => {
      requestedUrl = url;
      return Buffer.from('VALUE = 2\n');
    },
  });
  assert.match(requestedUrl, new RegExp(`/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/src/analyzer\\.py$`));
  assert.deepEqual(result.downloadedPaths, ['src/analyzer.py']);
  assert.equal(await fs.readFile(path.join(root, 'src', 'analyzer.py'), 'utf8'), 'VALUE = 2\n');
});

test('github client treats not-modified as no change', async () => {
  const result = await fetchUpstreamCompare({ currentCommit: 'a'.repeat(40), requestJson: async () => ({ status: 304, body: null }) });
  assert.equal(result.headCommit, '');
  assert.deepEqual(result.changedPaths, []);
  assert.equal(result.notModified, true);
});

test('github client retries a timed-out compare request', async () => {
  let attempts = 0;
  const result = await fetchUpstreamCompare({
    currentCommit: 'a'.repeat(40),
    retryDelaysMs: [0, 0],
    requestJson: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('GitHub request timed out');
      return { status: 200, body: { head: { sha: 'b'.repeat(40) }, files: [] } };
    },
  });
  assert.equal(attempts, 2);
  assert.equal(result.headCommit, 'b'.repeat(40));
});

test('github client retries an interrupted exact-commit file download', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stockmaster-download-retry-'));
  let attempts = 0;
  const result = await downloadUpstreamFiles({
    commit: 'b'.repeat(40),
    paths: ['src/analyzer.py'],
    destinationRoot: root,
    retryDelaysMs: [0, 0],
    download: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('Upstream file download timed out');
      return Buffer.from('VALUE = 2\n');
    },
  });
  assert.equal(attempts, 2);
  assert.deepEqual(result.downloadedPaths, ['src/analyzer.py']);
});

test('github compare preserves rename metadata for local overlay merging', async () => {
  const result = await fetchUpstreamCompare({
    currentCommit: 'a'.repeat(40),
    requestJson: async () => ({
      status: 200,
      body: {
        head: { sha: 'b'.repeat(40) },
        files: [{ filename: 'src/new.py', previous_filename: 'src/old.py', status: 'renamed' }],
      },
    }),
  });
  assert.deepEqual(result.changedFiles, [{ path: 'src/new.py', status: 'renamed', previousPath: 'src/old.py' }]);
});
