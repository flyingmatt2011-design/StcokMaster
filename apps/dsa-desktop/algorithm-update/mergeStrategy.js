const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');

const MAX_MERGE_OUTPUT_BYTES = 32 * 1024 * 1024;

function runMergeFile(args, { spawnProcess = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess('git', ['merge-file', ...args], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;

    function fail(error) {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* best effort */ }
      reject(error);
    }

    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_MERGE_OUTPUT_BYTES) {
        fail(new Error('Merged backend file exceeds the output size limit'));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= MAX_MERGE_OUTPUT_BYTES) stderr.push(chunk);
    });
    child.on('error', (error) => {
      fail(new Error(`Unable to run git merge-file: ${error.message}`, { cause: error }));
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      if (code === null) {
        reject(new Error(`git merge-file terminated by signal ${signal || 'unknown'}`));
        return;
      }
      resolve({
        code: Number(code),
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr).toString('utf8').trim(),
      });
    });
  });
}

async function mergeTextFileLocalWins({ localPath, basePath, upstreamPath, run = runMergeFile } = {}) {
  if (!localPath || !basePath || !upstreamPath) {
    throw new TypeError('localPath, basePath, and upstreamPath are required');
  }
  const mergeArgs = ['-p', '--diff3', localPath, basePath, upstreamPath];
  const attempted = await run(mergeArgs);
  if (attempted.code === 0) {
    return { content: attempted.stdout, conflicted: false };
  }
  if (attempted.code < 1 || attempted.code > 127) {
    throw new Error(`Three-way merge failed: ${attempted.stderr || `exit code ${attempted.code}`}`);
  }

  // A hunk-level "ours" result may still retain non-conflicting upstream
  // callers while dropping a conflicting local implementation (or vice
  // versa), producing a syntactically valid but semantically incomplete file.
  // The StockMaster contract treats any true conflict as a file-level strong
  // requirement: keep the complete local file and report the conflict.
  return { content: await fs.readFile(localPath), conflicted: true };
}

module.exports = {
  MAX_MERGE_OUTPUT_BYTES,
  mergeTextFileLocalWins,
  runMergeFile,
};
