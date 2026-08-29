const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createStateStore } = require('../algorithm-update/stateStore');

test('state store writes and reads JSON atomically', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stockmaster-update-'));
  const filePath = path.join(root, 'state.json');
  const store = createStateStore(filePath, { currentCommit: 'baseline', skippedCommits: [] });
  assert.deepEqual(await store.read(), { currentCommit: 'baseline', skippedCommits: [] });
  await store.write({ currentCommit: 'candidate', skippedCommits: ['ui'] });
  assert.deepEqual(await store.read(), { currentCommit: 'candidate', skippedCommits: ['ui'] });
  assert.equal((await fs.readdir(root)).some((name) => name.includes('.tmp')), false);
});
