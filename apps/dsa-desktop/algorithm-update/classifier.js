const path = require('node:path');

function normalizePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0')) return null;
  const normalized = value.replaceAll('\\', '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) return null;
  const parts = normalized.split('/');
  if (parts.includes('..') || parts.includes('')) return null;
  return parts.join('/');
}

function hasRoot(file, roots) {
  return roots.some((root) => file === root.slice(0, -1) || file.startsWith(root));
}

function classifyChangedPaths(paths, policy) {
  const eligiblePaths = [];
  const dependencyPaths = [];
  const excludedPaths = [];
  const blockedPaths = [];
  const reasons = [];
  const seen = new Set();

  for (const original of paths || []) {
    const file = normalizePath(original);
    if (!file || seen.has(file.toLowerCase())) {
      blockedPaths.push(original);
      reasons.push(`${original}: invalid, duplicate, or unsafe path`);
      continue;
    }
    seen.add(file.toLowerCase());
    const extension = path.posix.extname(file).toLowerCase();
    if (policy.blockedExtensions.includes(extension)) {
      blockedPaths.push(file);
    } else if (policy.dependencyFiles.includes(file)) {
      dependencyPaths.push(file);
    } else if (hasRoot(file, policy.eligibleRoots) || policy.eligibleFiles.includes(file)) {
      eligiblePaths.push(file);
    } else {
      excludedPaths.push(file);
    }
  }

  const hasUi = excludedPaths.some((file) => hasRoot(file, policy.uiRoots));
  const hasEligible = eligiblePaths.length > 0;
  const hasDependency = dependencyPaths.length > 0;
  let kind = 'irrelevant';
  if (blockedPaths.length) kind = 'unsafe';
  else if (hasEligible && hasUi) kind = 'mixed';
  else if (hasEligible) kind = 'backend_algorithm';
  else if (hasDependency) kind = 'dependency_only';
  else if (hasUi) kind = 'ui_only';

  return {
    kind,
    eligiblePaths: eligiblePaths.sort(),
    dependencyPaths: dependencyPaths.sort(),
    excludedPaths: excludedPaths.sort(),
    blockedPaths: blockedPaths.sort(),
    reasons,
  };
}

module.exports = { classifyChangedPaths, normalizePath };
