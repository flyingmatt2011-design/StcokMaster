const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyChangedPaths } = require('../algorithm-update/classifier');
const { DEFAULT_POLICY } = require('../algorithm-update/constants');

test('algorithm update classifier separates UI-only and backend changes', () => {
  assert.equal(classifyChangedPaths(['apps/dsa-web/src/App.tsx'], DEFAULT_POLICY).kind, 'ui_only');
  const backend = classifyChangedPaths(['src/analyzer.py'], DEFAULT_POLICY);
  assert.equal(backend.kind, 'backend_algorithm');
  assert.deepEqual(backend.eligiblePaths, ['src/analyzer.py']);
});
test('mixed changes exclude UI and dependency-only changes are not offered', () => {
  const mixed = classifyChangedPaths(['src/analyzer.py', 'apps/dsa-web/src/App.tsx'], DEFAULT_POLICY);
  assert.equal(mixed.kind, 'mixed');
  assert.deepEqual(mixed.eligiblePaths, ['src/analyzer.py']);
  assert.equal(classifyChangedPaths(['pyproject.toml'], DEFAULT_POLICY).kind, 'dependency_only');
});

test('unsafe paths are blocked deterministically', () => {
  const result = classifyChangedPaths(['../secret.py', 'src/tool.exe'], DEFAULT_POLICY);
  assert.equal(result.kind, 'unsafe');
  assert.equal(result.blockedPaths.length, 2);
});
