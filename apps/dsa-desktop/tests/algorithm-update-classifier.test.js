const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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

test('report templates are synchronized as backend runtime dependencies', () => {
  const result = classifyChangedPaths([
    'templates/report_markdown.j2',
    'apps/dsa-web/src/App.tsx',
  ], DEFAULT_POLICY);
  assert.equal(result.kind, 'mixed');
  assert.deepEqual(result.eligiblePaths, ['templates/report_markdown.j2']);
});

test('unsafe paths are blocked deterministically', () => {
  const result = classifyChangedPaths(['../secret.py', 'src/tool.exe'], DEFAULT_POLICY);
  assert.equal(result.kind, 'unsafe');
  assert.equal(result.blockedPaths.length, 2);
});

test('packaged update policy mirrors the executable StockMaster protection policy', () => {
  const packagedPolicy = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, '..', '..', '..', 'stockmaster', 'algorithm-update-policy.json'),
    'utf8',
  ));
  assert.equal(packagedPolicy.mergeStrategy, DEFAULT_POLICY.mergeStrategy);
  assert.equal(packagedPolicy.conflictResolution, DEFAULT_POLICY.conflictResolution);
  assert.deepEqual(packagedPolicy.strongRequirementPaths, DEFAULT_POLICY.strongRequirementPaths);
  assert.equal(classifyChangedPaths(['requirements-kronos.txt'], DEFAULT_POLICY).kind, 'irrelevant');
});
