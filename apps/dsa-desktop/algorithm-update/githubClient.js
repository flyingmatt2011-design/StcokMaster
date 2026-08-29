const https = require('node:https');
const fs = require('node:fs/promises');
const path = require('node:path');
const { normalizePath } = require('./classifier');

const REPOSITORY = 'ZhuLinsen/daily_stock_analysis';
const BRANCH = 'main';
const USER_AGENT = 'StockMaster-algorithm-updater';
const RAW_HOST = 'raw.githubusercontent.com';
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 80 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_DELAYS_MS = Object.freeze([0, 750, 2_000]);

function wait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function withRetry(operation, { delays = RETRY_DELAYS_MS, label = 'GitHub request' } = {}) {
  let lastError = null;
  for (let index = 0; index < delays.length; index += 1) {
    if (delays[index] > 0) await wait(delays[index]);
    try {
      return await operation(index + 1);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw new Error(`${label} failed after ${delays.length} attempts: ${lastError?.message || 'unknown error'}`, { cause: lastError });
}

function defaultRequestJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: options.headers || {} }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        let parsed = null;
        try { parsed = body ? JSON.parse(body) : null; } catch { parsed = null; }
        resolve({ status: response.statusCode || 0, headers: response.headers, body: parsed });
      });
    });
    request.setTimeout(options.timeoutMs || REQUEST_TIMEOUT_MS, () => request.destroy(new Error('GitHub request timed out')));
    request.on('error', reject);
  });
}

async function fetchUpstreamCompare({
  currentCommit,
  etag,
  requestJson = defaultRequestJson,
  retryDelaysMs = RETRY_DELAYS_MS,
} = {}) {
  if (!/^[0-9a-f]{40}$/i.test(String(currentCommit || ''))) throw new Error('A full current commit SHA is required');
  const url = `https://api.github.com/repos/${REPOSITORY}/compare/${currentCommit}...${BRANCH}`;
  const requestOptions = {
    timeoutMs: REQUEST_TIMEOUT_MS,
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': USER_AGENT,
      ...(etag ? { 'If-None-Match': etag } : {}),
    },
  };
  const response = await withRetry(async () => {
    const result = await requestJson(url, requestOptions);
    if (result?.status === 429 || result?.status >= 500) throw new Error(`GitHub compare returned status ${result.status}`);
    return result;
  }, { delays: retryDelaysMs, label: 'GitHub compare request' });
  if (response.status === 304) return { headCommit: '', changedPaths: [], notModified: true, etag: response.headers?.etag || etag || '' };
  if (response.status < 200 || response.status >= 300 || !response.body) throw new Error(`GitHub compare failed with status ${response.status}`);
  const files = Array.isArray(response.body.files) ? response.body.files : [];
  return {
    headCommit: String(response.body?.head?.sha || response.body?.commits?.at(-1)?.sha || ''),
    changedPaths: files.map((file) => file && file.filename).filter((file) => typeof file === 'string'),
    changedFiles: files
      .map((file) => ({
        path: file?.filename,
        status: file?.status,
        ...(typeof file?.previous_filename === 'string' ? { previousPath: file.previous_filename } : {}),
      }))
      .filter((file) => typeof file.path === 'string' && typeof file.status === 'string'),
    filesTruncated: files.length >= 300,
    etag: response.headers?.etag || '',
    notModified: false,
  };
}

function defaultDownload(url, { timeoutMs = 15_000, maxBytes = MAX_FILE_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { 'User-Agent': USER_AGENT } }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Upstream file download failed with status ${response.statusCode}`));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          request.destroy(new Error('Upstream file exceeds the download size limit'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('Upstream file download timed out')));
    request.on('error', reject);
  });
}

async function downloadUpstreamFiles({
  commit,
  paths,
  destinationRoot,
  download = defaultDownload,
  retryDelaysMs = RETRY_DELAYS_MS,
} = {}) {
  if (!/^[0-9a-f]{40}$/i.test(String(commit || ''))) throw new Error('A full candidate commit SHA is required');
  const root = path.resolve(destinationRoot || '');
  const normalizedPaths = [...new Set((paths || []).map(normalizePath))];
  if (!root || normalizedPaths.some((file) => !file)) throw new Error('Candidate download paths are invalid');
  let totalBytes = 0;
  for (const file of normalizedPaths) {
    const encodedPath = file.split('/').map(encodeURIComponent).join('/');
    const url = `https://${RAW_HOST}/${REPOSITORY}/${commit}/${encodedPath}`;
    const content = await withRetry(
      () => download(url, { timeoutMs: REQUEST_TIMEOUT_MS, maxBytes: MAX_FILE_BYTES }),
      { delays: retryDelaysMs, label: `Upstream file download (${file})` },
    );
    if (!Buffer.isBuffer(content)) throw new Error(`Upstream file returned invalid content: ${file}`);
    totalBytes += content.length;
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error('Candidate download exceeds the total size limit');
    const target = path.resolve(root, ...file.split('/'));
    const relative = path.relative(root, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Candidate path escapes staging: ${file}`);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
  return { downloadedPaths: normalizedPaths, totalBytes };
}

module.exports = {
  fetchUpstreamCompare,
  downloadUpstreamFiles,
  defaultDownload,
  REPOSITORY,
  BRANCH,
  USER_AGENT,
  RAW_HOST,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  REQUEST_TIMEOUT_MS,
  RETRY_DELAYS_MS,
  withRetry,
};
