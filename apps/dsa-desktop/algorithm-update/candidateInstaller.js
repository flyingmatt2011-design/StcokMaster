const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { DEFAULT_POLICY } = require('./constants');
const { normalizePath } = require('./classifier');
const { mergeTextFileLocalWins } = require('./mergeStrategy');

function isWithin(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function matchesEligibleRoot(file, policy) {
  return policy.eligibleRoots.some((root) => file.startsWith(root)) || policy.eligibleFiles.includes(file);
}

const EXCLUDED_RUNTIME_ROOTS = new Set([
  '.git', '.github', '.venv', 'venv', 'node_modules', 'apps', 'artifacts',
  'data', 'dist', 'docker', 'docs', 'logs', '__pycache__', '.pytest_cache',
]);
const EXCLUDED_RUNTIME_FILES = new Set(['.env', '.env.local']);
const REQUIRED_RUNTIME_FILES = Object.freeze(['main.py', 'server.py']);

function shouldCopyRuntimePath(currentRoot, sourcePath) {
  const relative = path.relative(path.resolve(currentRoot), path.resolve(sourcePath));
  if (!relative) return true;
  if (relative.startsWith('..') || path.isAbsolute(relative)) return false;
  const normalized = relative.replaceAll('\\', '/');
  const parts = normalized.split('/');
  if (EXCLUDED_RUNTIME_ROOTS.has(parts[0])) return false;
  if (parts.some((part) => part === '__pycache__')) return false;
  if (EXCLUDED_RUNTIME_FILES.has(normalized)) return false;
  if (/\.(db|db-wal|db-shm|log|pyc)$/i.test(normalized)) return false;
  return true;
}

async function copyRuntimeTree(currentRoot, sourcePath, candidateRoot, targetPath) {
  if (!shouldCopyRuntimePath(currentRoot, sourcePath)) return;
  const info = await fs.lstat(sourcePath);
  if (info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    await fs.mkdir(targetPath, { recursive: true });
    const entries = await fs.readdir(sourcePath);
    for (const entry of entries) {
      const childSource = path.join(sourcePath, entry);
      const childTarget = path.join(targetPath, entry);
      if (!isWithin(currentRoot, childSource) || !isWithin(candidateRoot, childTarget)) {
        throw new Error(`Runtime copy path escapes candidate: ${entry}`);
      }
      await copyRuntimeTree(currentRoot, childSource, candidateRoot, childTarget);
    }
    return;
  }
  if (!info.isFile()) return;
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.copyFile(sourcePath, targetPath);
}

async function filesEqual(firstPath, secondPath) {
  try {
    const [first, second] = await Promise.all([
      fs.readFile(firstPath),
      fs.readFile(secondPath),
    ]);
    return first.equals(second);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function persistMergeInputs({
  candidateRoot,
  localBaselineRoot,
  localUpstreamRoot,
}) {
  const mergeInputRoot = path.join(candidateRoot, '.stockmaster-merge');
  await fs.rm(mergeInputRoot, { recursive: true, force: true });
  await fs.mkdir(mergeInputRoot, { recursive: true });
  for (const [name, sourceRoot] of [
    ['baseline', localBaselineRoot],
    ['upstream', localUpstreamRoot],
  ]) {
    const destination = path.join(mergeInputRoot, name);
    await fs.mkdir(destination, { recursive: true });
    if (sourceRoot && await pathExists(sourceRoot)) {
      await fs.cp(sourceRoot, destination, { recursive: true, force: true });
    }
  }
  return mergeInputRoot;
}

async function applyLocalOverlayPolicy({
  candidateRoot,
  localRoot,
  localOverlayPaths = [],
  localBaselineRoot,
  localUpstreamRoot,
  localChangeStatuses = {},
  localRenameTargets = {},
  mergeFile = mergeTextFileLocalWins,
}) {
  const summary = {
    policy: DEFAULT_POLICY.mergeStrategy,
    overlayPaths: [],
    mergedPaths: [],
    conflictPaths: [],
    localOnlyPaths: [],
    upstreamOnlyPaths: [],
    acceptedRemovalPaths: [],
  };
  if (!localRoot || !localOverlayPaths.length) return summary;

  const resolvedCandidate = path.resolve(candidateRoot);
  const resolvedLocal = path.resolve(localRoot);
  const resolvedBaseline = localBaselineRoot ? path.resolve(localBaselineRoot) : '';
  const resolvedUpstream = localUpstreamRoot ? path.resolve(localUpstreamRoot) : '';

  for (const original of localOverlayPaths) {
    const relative = normalizePath(original);
    if (!relative || !matchesEligibleRoot(relative, DEFAULT_POLICY)) {
      throw new Error(`Local overlay path is not allowlisted: ${original}`);
    }
    const localPath = path.resolve(resolvedLocal, ...relative.split('/'));
    const renameTarget = normalizePath(localRenameTargets[relative]);
    if (localRenameTargets[relative] && (!renameTarget || !matchesEligibleRoot(renameTarget, DEFAULT_POLICY))) {
      throw new Error(`Local rename target is not allowlisted: ${localRenameTargets[relative]}`);
    }
    const effectiveTarget = renameTarget || relative;
    const targetPath = path.resolve(resolvedCandidate, ...effectiveTarget.split('/'));
    const originalTargetPath = path.resolve(resolvedCandidate, ...relative.split('/'));
    if (!isWithin(resolvedLocal, localPath) || !isWithin(resolvedCandidate, targetPath)) {
      throw new Error(`Local overlay path escapes its root: ${relative}`);
    }
    const localInfo = await fs.lstat(localPath);
    if (!localInfo.isFile() || localInfo.isSymbolicLink()) {
      throw new Error(`Local overlay is not a regular file: ${relative}`);
    }

    summary.overlayPaths.push(relative);
    const status = String(localChangeStatuses[relative] || 'unchanged');
    const basePath = resolvedBaseline
      ? path.resolve(resolvedBaseline, ...relative.split('/'))
      : '';
    const upstreamPath = resolvedUpstream
      ? path.resolve(resolvedUpstream, ...effectiveTarget.split('/'))
      : '';

    if (status === 'renamed') {
      if (!renameTarget || !resolvedBaseline || !resolvedUpstream) {
        throw new Error(`Rename merge inputs are missing: ${relative}`);
      }
      if (!isWithin(resolvedBaseline, basePath) || !isWithin(resolvedUpstream, upstreamPath)) {
        throw new Error(`Rename merge path escapes staging: ${relative}`);
      }
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      if (await filesEqual(localPath, basePath)) {
        await fs.copyFile(upstreamPath, targetPath);
        summary.upstreamOnlyPaths.push(relative);
      } else {
        const merged = await mergeFile({ localPath, basePath, upstreamPath });
        await fs.writeFile(targetPath, merged.content);
        summary.mergedPaths.push(relative);
        if (merged.conflicted) summary.conflictPaths.push(relative);
      }
      if (originalTargetPath !== targetPath) await fs.rm(originalTargetPath, { force: true });
      continue;
    }

    if (status === 'modified') {
      if (!resolvedBaseline || !resolvedUpstream) {
        throw new Error(`Three-way merge inputs are missing: ${relative}`);
      }
      if (!isWithin(resolvedBaseline, basePath) || !isWithin(resolvedUpstream, upstreamPath)) {
        throw new Error(`Merge path escapes staging: ${relative}`);
      }
      if (await filesEqual(localPath, basePath)) {
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.copyFile(upstreamPath, targetPath);
        summary.upstreamOnlyPaths.push(relative);
        continue;
      }
      const merged = await mergeFile({ localPath, basePath, upstreamPath });
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, merged.content);
      summary.mergedPaths.push(relative);
      if (merged.conflicted) summary.conflictPaths.push(relative);
      continue;
    }

    if (status === 'removed') {
      if (!resolvedBaseline) throw new Error(`Baseline merge input is missing: ${relative}`);
      if (!isWithin(resolvedBaseline, basePath)) throw new Error(`Baseline path escapes staging: ${relative}`);
      if (await filesEqual(localPath, basePath)) {
        await fs.rm(targetPath, { force: true });
        summary.acceptedRemovalPaths.push(relative);
      } else {
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.copyFile(localPath, targetPath);
        summary.conflictPaths.push(relative);
      }
      continue;
    }

    if (status === 'added' || status === 'copied') {
      if (!resolvedUpstream) throw new Error(`Upstream merge input is missing: ${relative}`);
      if (await filesEqual(localPath, upstreamPath)) {
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.copyFile(upstreamPath, targetPath);
      } else {
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.copyFile(localPath, targetPath);
        summary.conflictPaths.push(relative);
      }
      continue;
    }

    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.copyFile(localPath, targetPath);
    summary.localOnlyPaths.push(relative);
  }
  return summary;
}

function validateArchiveEntries(entries, policy = DEFAULT_POLICY) {
  const allowedPaths = [];
  const blockedPaths = [];
  const seen = new Set();
  for (const entry of entries || []) {
    const original = entry?.path;
    const normalized = normalizePath(original);
    const key = normalized?.toLowerCase();
    const blocked = !normalized
      || !key
      || seen.has(key)
      || entry?.type !== 'file'
      || !Number.isFinite(Number(entry?.size))
      || Number(entry.size) < 0
      || !matchesEligibleRoot(normalized, policy)
      || policy.blockedExtensions.includes(path.posix.extname(normalized).toLowerCase())
      || normalized.startsWith('apps/dsa-web/')
      || normalized.startsWith('apps/dsa-desktop/')
      || normalized.startsWith('data/')
      || normalized.startsWith('logs/');
    if (blocked) {
      blockedPaths.push(typeof original === 'string' ? original : String(original));
      continue;
    }
    seen.add(key);
    allowedPaths.push(normalized);
  }
  return { allowedPaths: allowedPaths.sort(), blockedPaths: blockedPaths.sort(), ok: blockedPaths.length === 0 };
}

async function stageBackendCandidate({
  currentRoot,
  archiveRoot,
  stagingRoot,
  eligiblePaths = [],
  dependencyPaths = [],
  removedPaths = [],
  localRoot = '',
  localOverlayPaths = [],
  localBaselineRoot = '',
  localUpstreamRoot = '',
  localChangeStatuses = {},
  localRenameTargets = {},
  localBaselineCommit = '',
  candidateCommit = '',
  mergeFile = mergeTextFileLocalWins,
}) {
  const current = path.resolve(currentRoot);
  const archive = path.resolve(archiveRoot);
  const staging = path.resolve(stagingRoot);
  if (!isWithin(staging, stagingRoot) || !isWithin(current, currentRoot) || !isWithin(archive, archiveRoot)) throw new Error('Invalid staging roots');
  await fs.mkdir(staging, { recursive: true });
  const candidateRoot = path.join(staging, `candidate-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
  await copyRuntimeTree(current, current, candidateRoot, candidateRoot);
  await fs.mkdir(candidateRoot, { recursive: true });
  const removed = new Set(removedPaths.map(normalizePath));
  for (const requiredFile of REQUIRED_RUNTIME_FILES) {
    if (removed.has(requiredFile)) throw new Error(`Candidate cannot remove required runtime entry: ${requiredFile}`);
    const source = path.join(current, requiredFile);
    const target = path.join(candidateRoot, requiredFile);
    let info;
    try {
      info = await fs.lstat(source);
    } catch (error) {
      throw new Error(`Current backend is missing required runtime entry: ${requiredFile}`, { cause: error });
    }
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`Current backend runtime entry is not a regular file: ${requiredFile}`);
    }
    try {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(source, target);
    } catch (error) {
      throw new Error(`Failed to copy required runtime entry ${requiredFile}: ${error.message}`, { cause: error });
    }
  }
  const overlays = [...eligiblePaths, ...dependencyPaths].filter((file) => !removed.has(normalizePath(file)));
  for (const original of overlays) {
    const relative = normalizePath(original);
    if (!relative || !matchesEligibleRoot(relative, DEFAULT_POLICY) && !DEFAULT_POLICY.dependencyFiles.includes(relative)) throw new Error(`Overlay path is not allowlisted: ${original}`);
    const source = path.join(archive, relative);
    const target = path.join(candidateRoot, relative);
    if (!isWithin(archive, source) || !isWithin(candidateRoot, target)) throw new Error(`Overlay path escapes runtime: ${original}`);
    const info = await fs.lstat(source);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Overlay source is not a regular file: ${relative}`);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target);
  }
  for (const original of removed) {
    const relative = normalizePath(original);
    if (!relative || !matchesEligibleRoot(relative, DEFAULT_POLICY) && !DEFAULT_POLICY.dependencyFiles.includes(relative)) {
      throw new Error(`Removed path is not allowlisted: ${original}`);
    }
    const target = path.join(candidateRoot, relative);
    if (!isWithin(candidateRoot, target)) throw new Error(`Removed path escapes runtime: ${original}`);
    await fs.rm(target, { force: true });
  }
  const mergeSummary = await applyLocalOverlayPolicy({
    candidateRoot,
    localRoot,
    localOverlayPaths,
    localBaselineRoot,
    localUpstreamRoot,
    localChangeStatuses,
    localRenameTargets,
    mergeFile,
  });
  await persistMergeInputs({
    candidateRoot,
    localBaselineRoot,
    localUpstreamRoot,
  });
  const manifest = {
    eligiblePaths,
    dependencyPaths,
    removedPaths: [...removed],
    candidateCommit,
    localBaselineCommit,
    localChangeStatuses,
    localRenameTargets,
    mergeInputDirectory: '.stockmaster-merge',
    mergeSummary,
    createdAt: new Date().toISOString(),
  };
  await fs.writeFile(path.join(candidateRoot, 'stockmaster-candidate.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { ok: true, candidateRoot, mergeSummary };
}

module.exports = {
  validateArchiveEntries,
  stageBackendCandidate,
  isWithin,
  shouldCopyRuntimePath,
  copyRuntimeTree,
  applyLocalOverlayPolicy,
  filesEqual,
  persistMergeInputs,
  REQUIRED_RUNTIME_FILES,
};
