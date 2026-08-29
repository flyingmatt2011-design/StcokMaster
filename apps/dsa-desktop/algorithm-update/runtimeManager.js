const fs = require('node:fs/promises');
const path = require('node:path');

function assertCommit(commit) {
  if (!/^[0-9a-f]{40}$/i.test(String(commit || ''))) throw new Error('A full commit SHA is required');
}

async function readPointer(filePath) {
  try { return JSON.parse(await fs.readFile(filePath, 'utf8')); } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new Error(`Invalid runtime pointer: ${filePath}`);
  }
}

async function writeAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(temporary, filePath);
}

async function ensureCurrentPointer({ runtimeRoot, pointer }) {
  const root = path.resolve(runtimeRoot);
  const currentFile = path.join(root, 'current.json');
  const current = await readPointer(currentFile);
  if (current) return current;
  if (!pointer || !/^[0-9a-f]{40}$/i.test(String(pointer.commit || '')) || !pointer.path) {
    throw new Error('A valid initial runtime pointer is required');
  }
  const initial = { commit: String(pointer.commit), path: path.resolve(pointer.path), activatedAt: pointer.activatedAt || new Date().toISOString() };
  await writeAtomic(currentFile, initial);
  return initial;
}

async function activateCandidate({
  runtimeRoot,
  commit,
  candidatePath,
  stopBackend,
  startBackend,
  healthCheck,
  metadata = {},
}) {
  assertCommit(commit);
  if (typeof stopBackend !== 'function' || typeof startBackend !== 'function' || typeof healthCheck !== 'function') throw new TypeError('runtime lifecycle callbacks are required');
  const root = path.resolve(runtimeRoot);
  const candidate = path.resolve(candidatePath);
  await fs.mkdir(root, { recursive: true });
  const currentFile = path.join(root, 'current.json');
  const previousFile = path.join(root, 'previous.json');
  const oldPointer = await readPointer(currentFile);
  const installedPath = path.join(root, commit);
  await fs.rm(installedPath, { recursive: true, force: true });
  await fs.cp(candidate, installedPath, { recursive: true, dereference: false });
  if (oldPointer) await writeAtomic(previousFile, oldPointer);
  const nextPointer = {
    commit,
    path: installedPath,
    activatedAt: new Date().toISOString(),
    mergePolicy: String(metadata.mergePolicy || ''),
    localBaselineCommit: String(metadata.localBaselineCommit || ''),
    localMergedPaths: Array.isArray(metadata.localMergedPaths) ? [...metadata.localMergedPaths] : [],
    localConflictPaths: Array.isArray(metadata.localConflictPaths) ? [...metadata.localConflictPaths] : [],
  };
  await writeAtomic(currentFile, nextPointer);
  await stopBackend();
  try {
    await startBackend(installedPath);
    if (!(await healthCheck(installedPath))) throw new Error('Candidate runtime health check failed');
    return nextPointer;
  } catch (error) {
    await stopBackend();
    if (oldPointer) {
      await writeAtomic(currentFile, oldPointer);
      await startBackend(oldPointer.path);
    } else {
      await fs.rm(currentFile, { force: true });
    }
    throw error;
  }
}

module.exports = { activateCandidate, readPointer, ensureCurrentPointer };
