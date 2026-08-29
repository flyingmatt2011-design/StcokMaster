const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { mergeTextFileLocalWins } = require('../algorithm-update/mergeStrategy');

async function createMergeFiles({ base, local, upstream }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stockmaster-merge-'));
  const paths = {
    basePath: path.join(root, 'base.py'),
    localPath: path.join(root, 'local.py'),
    upstreamPath: path.join(root, 'upstream.py'),
  };
  await Promise.all([
    fs.writeFile(paths.basePath, base),
    fs.writeFile(paths.localPath, local),
    fs.writeFile(paths.upstreamPath, upstream),
  ]);
  return paths;
}

test('three-way merge preserves compatible upstream and StockMaster changes', async () => {
  const paths = await createMergeFiles({
    base: 'first = "base"\nmiddle = 1\nlast = "base"\n',
    local: 'first = "stockmaster"\nmiddle = 1\nlast = "base"\n',
    upstream: 'first = "base"\nmiddle = 1\nlast = "upstream"\n',
  });
  const result = await mergeTextFileLocalWins(paths);
  assert.equal(result.conflicted, false);
  assert.match(result.content.toString('utf8'), /first = "stockmaster"/);
  assert.match(result.content.toString('utf8'), /last = "upstream"/);
});

test('three-way merge keeps the complete StockMaster file when any true conflict exists', async () => {
  const paths = await createMergeFiles({
    base: 'upstream_hook = false\nseparator_one = 1\nseparator_two = 2\ndecision = "base"\n',
    local: 'upstream_hook = false\nseparator_one = 1\nseparator_two = 2\ndecision = "stockmaster"\n',
    upstream: 'upstream_hook = true\nseparator_one = 1\nseparator_two = 2\ndecision = "upstream"\n',
  });
  const result = await mergeTextFileLocalWins(paths);
  const content = result.content.toString('utf8');
  assert.equal(result.conflicted, true);
  assert.equal(content, 'upstream_hook = false\nseparator_one = 1\nseparator_two = 2\ndecision = "stockmaster"\n');
  assert.doesNotMatch(content, /<{7}|={7}|>{7}/);
});
