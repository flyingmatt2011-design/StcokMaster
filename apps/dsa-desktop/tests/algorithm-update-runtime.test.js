const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { activateCandidate } = require('../algorithm-update/runtimeManager');

test('runtime activation keeps previous pointer and rolls back on health failure', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stockmaster-runtime-'));
  const candidate = path.join(root, 'staging');
  await fs.mkdir(candidate, { recursive: true });
  await fs.writeFile(path.join(candidate, 'server.py'), 'candidate');
  const runtimeRoot = path.join(root, 'runtimes');
  const old = path.join(runtimeRoot, 'old');
  await fs.mkdir(old, { recursive: true });
  await fs.writeFile(path.join(old, 'server.py'), 'old');
  await fs.writeFile(path.join(runtimeRoot, 'current.json'), JSON.stringify({ commit: 'a'.repeat(40), path: old }));
  const calls = [];
  await assert.rejects(() => activateCandidate({ runtimeRoot, commit: 'b'.repeat(40), candidatePath: candidate, stopBackend: async () => calls.push('stop'), startBackend: async (directory) => calls.push(`start:${directory.includes('b'.repeat(40)) ? 'new' : 'old'}`), healthCheck: async () => false }), /health/i);
  const pointer = JSON.parse(await fs.readFile(path.join(runtimeRoot, 'current.json'), 'utf8'));
  assert.equal(pointer.commit, 'a'.repeat(40));
  assert.deepEqual(calls, ['stop', 'start:new', 'stop', 'start:old']);
});

test('runtime activation persists merge audit metadata', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stockmaster-runtime-meta-'));
  const candidate = path.join(root, 'candidate');
  await fs.mkdir(candidate, { recursive: true });
  await fs.writeFile(path.join(candidate, 'server.py'), 'candidate');
  const pointer = await activateCandidate({
    runtimeRoot: path.join(root, 'runtimes'),
    commit: 'b'.repeat(40),
    candidatePath: candidate,
    stopBackend: async () => undefined,
    startBackend: async () => undefined,
    healthCheck: async () => true,
    metadata: {
      mergePolicy: 'three-way-local-wins',
      localBaselineCommit: 'a'.repeat(40),
      localMergedPaths: ['src/config.py'],
      localConflictPaths: ['src/config.py'],
    },
  });
  assert.equal(pointer.mergePolicy, 'three-way-local-wins');
  assert.deepEqual(pointer.localConflictPaths, ['src/config.py']);
});
