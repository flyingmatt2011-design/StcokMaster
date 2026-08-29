const { app, BrowserWindow, dialog, ipcMain, shell, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const net = require('net');
const http = require('http');
const https = require('https');
const { TextDecoder } = require('util');
const { classifyChangedPaths } = require('./algorithm-update/classifier');
const { DEFAULT_POLICY } = require('./algorithm-update/constants');
const { fetchUpstreamCompare } = require('./algorithm-update/githubClient');
const { downloadUpstreamFiles } = require('./algorithm-update/githubClient');
const { createAlgorithmUpdateMonitor } = require('./algorithm-update/monitor');
const { stageBackendCandidate, applyLocalOverlayPolicy } = require('./algorithm-update/candidateInstaller');
const { activateCandidate, ensureCurrentPointer, readPointer } = require('./algorithm-update/runtimeManager');
const { validatePythonCandidate } = require('./algorithm-update/validator');

let mainWindow = null;
let backendProcess = null;
let logFilePath = null;
let backendStartError = null;
let desktopUpdateState = null;
let lastNotifiedUpdateVersion = '';
let lastPromptedInstallVersion = '';
let electronAutoUpdater = undefined;
let electronAutoUpdaterConfigured = false;
let electronUpdateCheckInFlight = false;
let desktopBackendOrigin = '';
let algorithmUpdateMonitor = null;
let lastAlgorithmUpdatePromptCommit = '';
let activeBackendSourceRoot = '';
let backendRuntimeContext = null;
let algorithmSyncInFlight = null;

function resolveWindowBackgroundColor() {
  return nativeTheme.shouldUseDarkColors ? '#08080c' : '#f4f7fb';
}

function resolveStockMasterBaselineCommit() {
  const candidates = [
    path.join(appRootDev, 'stockmaster', 'upstream-baseline.json'),
    path.join(process.resourcesPath || '', 'stockmaster', 'upstream-baseline.json'),
  ];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      if (typeof parsed.commit === 'string' && /^[0-9a-f]{40}$/i.test(parsed.commit)) return parsed.commit;
    } catch { /* packaged builds may only have one of the candidates */ }
  }
  return '';
}

function resolveAlgorithmRuntimeRoot() {
  return path.join(app.getPath('userData'), 'stockmaster-algorithm-runtimes');
}

async function resolveActiveAlgorithmRuntime() {
  if (app.isPackaged) return null;
  const pointer = await readPointer(path.join(resolveAlgorithmRuntimeRoot(), 'current.json'));
  if (!pointer?.path || !pointer?.commit) return null;
  const resolved = path.resolve(pointer.path);
  const runtimeRoot = path.resolve(resolveAlgorithmRuntimeRoot());
  const relative = path.relative(runtimeRoot, resolved);
  const isManagedRuntime = relative && !relative.startsWith('..') && !path.isAbsolute(relative);
  const isDevelopmentRoot = resolved === path.resolve(appRootDev);
  if ((!isManagedRuntime && !isDevelopmentRoot) || !fs.existsSync(path.join(resolved, 'main.py'))) return null;
  let manifest = null;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(resolved, 'stockmaster-candidate.json'), 'utf8'));
  } catch { /* legacy runtimes do not have merge metadata */ }
  return {
    ...pointer,
    path: resolved,
    mergePolicy: pointer.mergePolicy || manifest?.mergeSummary?.policy || '',
    localBaselineCommit: pointer.localBaselineCommit || manifest?.localBaselineCommit || '',
    localMergedPaths: pointer.localMergedPaths || manifest?.mergeSummary?.mergedPaths || [],
    localConflictPaths: pointer.localConflictPaths || manifest?.mergeSummary?.conflictPaths || [],
  };
}

function startAlgorithmUpdateMonitor() {
  if (algorithmUpdateMonitor || process.argv.includes('--test') || !(app.isPackaged || process.env.STOCKMASTER_ENABLE_ALGORITHM_MONITOR === '1')) return;
  const currentCommit = backendRuntimeContext?.algorithmCommit || resolveStockMasterBaselineCommit();
  if (!currentCommit) return;
  algorithmUpdateMonitor = createAlgorithmUpdateMonitor({
    currentCommit,
    appliedCommit: backendRuntimeContext?.algorithmAppliedCommit || '',
    lastAppliedAt: backendRuntimeContext?.algorithmAppliedAt || '',
    mergePolicy: backendRuntimeContext?.algorithmMergePolicy || '',
    localBaselineCommit: backendRuntimeContext?.algorithmLocalBaselineCommit || '',
    localMergedPaths: backendRuntimeContext?.algorithmLocalMergedPaths || [],
    localConflictPaths: backendRuntimeContext?.algorithmLocalConflictPaths || [],
    fetchCompare: fetchUpstreamCompare,
    classify: (paths) => classifyChangedPaths(paths, DEFAULT_POLICY),
    onStateChanged: (state) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('algorithm-update:state', state);
    },
    onAvailable: async ({ headCommit, classification }) => {
      if (!mainWindow || mainWindow.isDestroyed() || headCommit === lastAlgorithmUpdatePromptCommit) return;
      lastAlgorithmUpdatePromptCommit = headCommit;
      const result = await dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'StockMaster 后端算法更新',
        message: '检测到上游后端分析算法有更新。',
        detail: `候选提交：${headCommit.slice(0, 8)}\n涉及文件：${classification.eligiblePaths.join(', ')}\n当前版本不会自动覆盖，是否打开更新说明？`,
        buttons: ['稍后', '查看变更', '立即同步'],
        defaultId: 0,
        cancelId: 0,
      });
      if (result.response === 1) {
        const activeCommit = algorithmUpdateMonitor?.getState().currentCommit || currentCommit;
        await shell.openExternal(`https://github.com/ZhuLinsen/daily_stock_analysis/compare/${activeCommit}...${headCommit}`);
      } else if (result.response === 2) {
        void syncAlgorithmUpdate().catch((error) => logLine(`[algorithm-update] sync failed: ${error.message}`));
      }
    },
  });
  void algorithmUpdateMonitor.start().catch((error) => logLine(`[algorithm-update] initial check failed: ${error.message}`));
  logLine('[algorithm-update] monitor started with 60s interval and failure backoff');
}

function stopAlgorithmUpdateMonitor() {
  algorithmUpdateMonitor?.stop();
  algorithmUpdateMonitor = null;
}

const isWindows = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const appRootDev = path.resolve(__dirname, '..', '..');
const GITHUB_OWNER = 'ZhuLinsen';
const GITHUB_REPO = 'daily_stock_analysis';
const RELEASES_PAGE_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases`;
const LATEST_RELEASE_API_URL = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;
const DEFAULT_REQUEST_TIMEOUT_MS = 5000;
const DESKTOP_UPDATE_BACKUP_DIR = '.dsa-desktop-update-backup';
const DESKTOP_UPDATE_BACKUP_MANIFEST_FILE = 'runtime-state.json';
const DESKTOP_BACKEND_DEFAULT_HOST = '127.0.0.1';
const DESKTOP_SHARE_IMAGE_WIDTH = 1080;
const DESKTOP_SHARE_IMAGE_INITIAL_HEIGHT = 720;
const DESKTOP_SHARE_IMAGE_MAX_HEIGHT = 20000;
const PUBLIC_BIND_HOSTS = Object.freeze(new Set(['0.0.0.0', '::', '[::]', '*']));
const MAC_DESKTOP_CLI_PATH_ENTRIES = Object.freeze([
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/opt/homebrew/sbin',
  '/usr/local/sbin',
]);
const MAC_DESKTOP_SYSTEM_PATH_ENTRIES = Object.freeze([
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
]);

function syncDevelopmentWebAssets({ repoRoot = appRootDev, runtimeRoot, enabled = true } = {}) {
  if (!enabled || !runtimeRoot) return false;
  const sourceStatic = path.resolve(repoRoot, 'static');
  const targetStatic = path.resolve(runtimeRoot, 'static');
  if (sourceStatic === targetStatic || !fs.existsSync(path.join(sourceStatic, 'index.html'))) return false;
  fs.mkdirSync(targetStatic, { recursive: true });
  fs.cpSync(sourceStatic, targetStatic, { recursive: true, force: true });
  return true;
}

const STOCKMASTER_BACKEND_ADAPTER_FILES = Object.freeze([
  path.join('api', 'app.py'),
  path.join('api', 'v1', 'endpoints', 'analysis.py'),
  path.join('api', 'v1', 'endpoints', 'history.py'),
  path.join('api', 'v1', 'endpoints', 'stocks.py'),
  path.join('api', 'v1', 'endpoints', 'system_config.py'),
  path.join('api', 'v1', 'schemas', 'analysis.py'),
  path.join('api', 'v1', 'schemas', 'history.py'),
  path.join('api', 'v1', 'schemas', 'stocks.py'),
  path.join('api', 'v1', 'schemas', 'system_config.py'),
  path.join('src', 'services', 'history_service.py'),
  path.join('src', 'services', 'analysis_service.py'),
  path.join('src', 'services', 'market_dashboard_service.py'),
  path.join('src', 'services', 'stock_service.py'),
  path.join('src', 'services', 'system_config_service.py'),
  // StockMaster-owned backend requirements. After an algorithm update these
  // paths use a persisted upstream baseline for three-way, local-wins replay.
  path.join('main.py'),
  path.join('src', 'core', 'pipeline.py'),
  path.join('src', 'core', 'config_profiles.py'),
  path.join('src', 'core', 'pipeline_helpers.py'),
  path.join('src', 'core', 'config_registry.py'),
  path.join('src', 'core', 'config_registry_categories.py'),
  path.join('src', 'core', 'market_review.py'),
  path.join('src', 'core', 'market_review_runtime.py'),
  path.join('src', 'core', 'trading_calendar.py'),
  path.join('src', 'config.py'),
  path.join('src', 'analyzer.py'),
  path.join('src', 'analysis_text_normalization.py'),
  path.join('src', 'market_analyzer.py'),
  path.join('src', 'storage.py'),
  path.join('src', 'storage_time.py'),
  path.join('src', 'search_service.py'),
  path.join('src', 'search_provider_base.py'),
  path.join('src', 'utils', 'data_processing.py'),
  path.join('src', 'services', 'analysis_context_builder.py'),
  path.join('src', 'services', 'analysis_retry_context.py'),
  path.join('src', 'services', 'a_share_market_temperature.py'),
  path.join('src', 'services', 'a_share_structured_intel.py'),
  path.join('src', 'services', 'chart_pattern_service.py'),
  path.join('src', 'services', 'intel_context_status.py'),
  path.join('src', 'services', 'provider_chain_diagnostics.py'),
  path.join('src', 'services', 'runtime_config_validation.py'),
  path.join('src', 'services', 'run_diagnostics.py'),
  path.join('src', 'services', 'task_queue.py'),
  path.join('src', 'stock_analyzer.py'),
  path.join('src', 'llm', 'backend_factory.py'),
  path.join('src', 'llm', 'litellm_backend.py'),
  path.join('data_provider', 'base.py'),
  path.join('data_provider', 'baostock_fetcher.py'),
  path.join('data_provider', 'a_share_valuation.py'),
  path.join('data_provider', 'baostock_fundamental_adapter.py'),
  path.join('data_provider', 'chip_distribution.py'),
  path.join('data_provider', 'fundamental_adapter.py'),
  path.join('data_provider', 'provider_daily_cache.py'),
  path.join('data_provider', 'realtime_types.py'),
  path.join('data_provider', 'akshare_fetcher.py'),
  path.join('data_provider', 'efinance_fetcher.py'),
]);

function syncDevelopmentBackendAdapters({ repoRoot = appRootDev, runtimeRoot, enabled = true } = {}) {
  if (!enabled || !runtimeRoot) return false;
  const resolvedRepoRoot = path.resolve(repoRoot);
  const resolvedRuntimeRoot = path.resolve(runtimeRoot);
  if (resolvedRepoRoot === resolvedRuntimeRoot) return false;

  for (const relativePath of STOCKMASTER_BACKEND_ADAPTER_FILES) {
    const sourcePath = path.resolve(resolvedRepoRoot, relativePath);
    const targetPath = path.resolve(resolvedRuntimeRoot, relativePath);
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`StockMaster backend adapter is missing: ${relativePath}`);
    }
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(sourcePath, targetPath);
  }
  return true;
}

async function replayDevelopmentBackendAdapters({ repoRoot = appRootDev, runtimeRoot, enabled = true } = {}) {
  if (!enabled || !runtimeRoot) return { applied: false, strategy: 'disabled' };
  const manifestPath = path.join(path.resolve(runtimeRoot), 'stockmaster-candidate.json');
  let manifest;
  try {
    manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return {
      applied: syncDevelopmentBackendAdapters({ repoRoot, runtimeRoot, enabled }),
      strategy: 'legacy-copy',
    };
  }
  if (manifest?.mergeSummary?.policy !== 'three-way-local-wins') {
    return {
      applied: syncDevelopmentBackendAdapters({ repoRoot, runtimeRoot, enabled }),
      strategy: 'legacy-copy',
    };
  }
  const mergeInputRoot = path.join(path.resolve(runtimeRoot), '.stockmaster-merge');
  const summary = await applyLocalOverlayPolicy({
    candidateRoot: runtimeRoot,
    localRoot: repoRoot,
    localOverlayPaths: STOCKMASTER_BACKEND_ADAPTER_FILES.map((file) => file.split(path.sep).join('/')),
    localBaselineRoot: path.join(mergeInputRoot, 'baseline'),
    localUpstreamRoot: path.join(mergeInputRoot, 'upstream'),
    localChangeStatuses: manifest.localChangeStatuses || {},
    localRenameTargets: manifest.localRenameTargets || {},
  });
  const updatedManifest = {
    ...manifest,
    mergeSummary: summary,
    lastLocalReplayAt: new Date().toISOString(),
  };
  const temporaryManifestPath = `${manifestPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.promises.writeFile(temporaryManifestPath, `${JSON.stringify(updatedManifest, null, 2)}\n`, 'utf8');
  await fs.promises.rename(temporaryManifestPath, manifestPath);
  return { applied: true, strategy: 'three-way-local-wins', summary };
}

const DESKTOP_BACKEND_PATH_DELIMITER = isWindows ? ';' : ':';
const DESKTOP_UPDATE_RUNTIME_RELATIVE_FILES = Object.freeze([
  '.env',
  path.join('data', 'stock_analysis.db'),
  path.join('data', 'stock_analysis.db-wal'),
  path.join('data', 'stock_analysis.db-shm'),
  path.join('data', 'screening', 'hotspots.json'),
  path.join('data', 'screening', 'hotspot.history.jsonl'),
  path.join('data', 'screening', 'hotspot_details'),
  path.join('data', 'screening', 'snapshot.last_good.json'),
  path.join('data', 'screening', 'daily_history'),
  path.join('data', 'screening', 'industry_provider_cache'),
  path.join('logs', 'desktop.log'),
]);

const UPDATE_STATUS = Object.freeze({
  IDLE: 'idle',
  CHECKING: 'checking',
  UP_TO_DATE: 'up-to-date',
  UPDATE_AVAILABLE: 'update-available',
  DOWNLOADING: 'downloading',
  UPDATE_DOWNLOADED: 'update-downloaded',
  INSTALLING: 'installing',
  ERROR: 'error',
});

const UPDATE_MODE = Object.freeze({
  AUTO: 'auto',
  MANUAL: 'manual',
});

function normalizeVersionString(version) {
  return String(version || '')
    .trim()
    .replace(/^v/i, '')
    .replace(/\+.*$/, '');
}

function parseSemver(version) {
  const normalized = normalizeVersionString(version);
  const match = normalized.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) {
    return null;
  }

  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

function comparePrereleaseIdentifiers(left, right) {
  const leftIsNumeric = /^\d+$/.test(left);
  const rightIsNumeric = /^\d+$/.test(right);

  if (leftIsNumeric && rightIsNumeric) {
    const leftNumber = Number.parseInt(left, 10);
    const rightNumber = Number.parseInt(right, 10);
    if (leftNumber === rightNumber) {
      return 0;
    }
    return leftNumber > rightNumber ? 1 : -1;
  }

  if (leftIsNumeric !== rightIsNumeric) {
    return leftIsNumeric ? -1 : 1;
  }

  if (left === right) {
    return 0;
  }
  return left > right ? 1 : -1;
}

function compareVersions(leftVersion, rightVersion) {
  const left = parseSemver(leftVersion);
  const right = parseSemver(rightVersion);
  if (!left || !right) {
    return null;
  }

  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) {
      return left[key] > right[key] ? 1 : -1;
    }
  }

  if (!left.prerelease.length && !right.prerelease.length) {
    return 0;
  }
  if (!left.prerelease.length) {
    return 1;
  }
  if (!right.prerelease.length) {
    return -1;
  }

  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined) {
      return -1;
    }
    if (rightPart === undefined) {
      return 1;
    }

    const compared = comparePrereleaseIdentifiers(leftPart, rightPart);
    if (compared !== 0) {
      return compared;
    }
  }

  return 0;
}

function normalizeFiniteNumber(value, fallback = null) {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }
  const numberValue = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}

function normalizeDownloadPercent(value) {
  const percent = normalizeFiniteNumber(value);
  if (percent === null) {
    return null;
  }
  return Math.min(100, Math.max(0, Math.round(percent * 10) / 10));
}

function buildUpdateState(state = {}) {
  return {
    status: state.status || UPDATE_STATUS.IDLE,
    updateMode: state.updateMode === UPDATE_MODE.AUTO ? UPDATE_MODE.AUTO : UPDATE_MODE.MANUAL,
    currentVersion: normalizeVersionString(state.currentVersion),
    latestVersion: normalizeVersionString(state.latestVersion),
    releaseUrl:
      typeof state.releaseUrl === 'string' && state.releaseUrl.trim()
        ? state.releaseUrl.trim()
        : RELEASES_PAGE_URL,
    checkedAt: typeof state.checkedAt === 'string' ? state.checkedAt : '',
    publishedAt: typeof state.publishedAt === 'string' ? state.publishedAt : '',
    message: typeof state.message === 'string' ? state.message : '',
    releaseName: typeof state.releaseName === 'string' ? state.releaseName : '',
    tagName: typeof state.tagName === 'string' ? state.tagName : '',
    downloadPercent: normalizeDownloadPercent(state.downloadPercent),
    downloadedBytes: normalizeFiniteNumber(state.downloadedBytes),
    totalBytes: normalizeFiniteNumber(state.totalBytes),
  };
}

function extractReleaseMetadata(release) {
  if (!release || typeof release !== 'object') {
    return null;
  }

  const tagName = typeof release.tag_name === 'string' ? release.tag_name.trim() : '';
  const version = normalizeVersionString(tagName);
  if (!parseSemver(version)) {
    return null;
  }

  return {
    tagName,
    version,
    releaseName: typeof release.name === 'string' ? release.name.trim() : '',
    releaseUrl:
      typeof release.html_url === 'string' && release.html_url.trim()
        ? release.html_url.trim()
        : RELEASES_PAGE_URL,
    publishedAt: typeof release.published_at === 'string' ? release.published_at : '',
  };
}

function evaluateReleaseUpdate({ currentVersion, release, checkedAt = new Date().toISOString() }) {
  const normalizedCurrentVersion = normalizeVersionString(currentVersion);
  if (!parseSemver(normalizedCurrentVersion)) {
    return buildUpdateState({
      status: UPDATE_STATUS.ERROR,
      currentVersion: normalizedCurrentVersion,
      checkedAt,
      message: '当前桌面端版本不是有效的语义化版本，无法检查更新。',
    });
  }

  const releaseMetadata = extractReleaseMetadata(release);
  if (!releaseMetadata) {
    return buildUpdateState({
      status: UPDATE_STATUS.ERROR,
      currentVersion: normalizedCurrentVersion,
      checkedAt,
      message: 'GitHub Release 未返回可识别的语义化版本标签。',
    });
  }

  const compared = compareVersions(normalizedCurrentVersion, releaseMetadata.version);
  if (compared === null) {
    return buildUpdateState({
      status: UPDATE_STATUS.ERROR,
      currentVersion: normalizedCurrentVersion,
      latestVersion: releaseMetadata.version,
      releaseUrl: releaseMetadata.releaseUrl,
      checkedAt,
      releaseName: releaseMetadata.releaseName,
      tagName: releaseMetadata.tagName,
      message: '版本比较失败，无法判断是否存在可用更新。',
    });
  }

  if (compared < 0) {
    return buildUpdateState({
      status: UPDATE_STATUS.UPDATE_AVAILABLE,
      currentVersion: normalizedCurrentVersion,
      latestVersion: releaseMetadata.version,
      releaseUrl: releaseMetadata.releaseUrl,
      checkedAt,
      publishedAt: releaseMetadata.publishedAt,
      releaseName: releaseMetadata.releaseName,
      tagName: releaseMetadata.tagName,
      message: `发现新版本 ${releaseMetadata.version}，可前往 GitHub Releases 下载更新。`,
    });
  }

  return buildUpdateState({
    status: UPDATE_STATUS.UP_TO_DATE,
    currentVersion: normalizedCurrentVersion,
    latestVersion: releaseMetadata.version,
    releaseUrl: releaseMetadata.releaseUrl,
    checkedAt,
    publishedAt: releaseMetadata.publishedAt,
    releaseName: releaseMetadata.releaseName,
    tagName: releaseMetadata.tagName,
    message: '当前桌面端已是最新版本。',
  });
}

function fetchLatestReleaseJson({
  requestUrl = LATEST_RELEASE_API_URL,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  request = https.request,
} = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let response = null;

    const cleanupResponseListeners = () => {
      if (!response) {
        return;
      }
      response.removeAllListeners('data');
      response.removeAllListeners('end');
      response.removeAllListeners('error');
      response.removeAllListeners('aborted');
      response.removeAllListeners('close');
    };

    const finishWithError = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanupResponseListeners();
      if (!req.destroyed) {
        req.destroy();
      }
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    const finishWithResult = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanupResponseListeners();
      resolve(value);
    };

    const req = request(
      requestUrl,
      {
        method: 'GET',
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'daily-stock-analysis-desktop',
        },
      },
      (incomingResponse) => {
        response = incomingResponse;
        const chunks = [];

        response.on('data', (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        });

        response.on('end', () => {
          if (settled) {
            return;
          }
          const body = Buffer.concat(chunks).toString('utf-8');
          if (response.statusCode !== 200) {
            finishWithError(new Error(`GitHub API responded with status ${response.statusCode || 'unknown'}`));
            return;
          }

          try {
            finishWithResult(JSON.parse(body));
          } catch (_error) {
            finishWithError(new Error('Failed to parse GitHub release response.'));
          }
        });

        response.on('error', (error) => {
          finishWithError(error);
        });
        response.on('aborted', () => {
          finishWithError(new Error('GitHub API response was aborted.'));
        });
        response.on('close', () => {
          if (!response.complete) {
            finishWithError(new Error('GitHub API response closed before completion.'));
          }
        });
      }
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`GitHub API timeout after ${timeoutMs}ms`));
    });
    req.on('error', finishWithError);
    req.end();
  });
}

async function checkForDesktopUpdates({
  currentVersion,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  fetchLatestRelease = fetchLatestReleaseJson,
} = {}) {
  const release = await fetchLatestRelease({ timeoutMs });
  return evaluateReleaseUpdate({ currentVersion, release });
}

desktopUpdateState = buildUpdateState();

function resolveEnvExamplePath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, '.env.example');
  }
  return path.join(appRootDev, '.env.example');
}

function resolvePackagedExeDir() {
  return path.dirname(app.getPath('exe'));
}

function resolveAppDir() {
  if (app.isPackaged && !isMac) {
    return resolvePackagedExeDir();
  }
  return app.getPath('userData');
}

function resolveUpdateBackupRoot() {
  return path.join(app.getPath('userData'), DESKTOP_UPDATE_BACKUP_DIR);
}

function resolveUpdateBackupManifestPath() {
  return path.join(resolveUpdateBackupRoot(), DESKTOP_UPDATE_BACKUP_MANIFEST_FILE);
}

function resolveRuntimeFileEntries(baseDir = resolveAppDir()) {
  return DESKTOP_UPDATE_RUNTIME_RELATIVE_FILES.map((relativePath) => ({
    relativePath,
    absolutePath: path.join(baseDir, relativePath),
    backupPath: path.join(resolveUpdateBackupRoot(), relativePath),
  }));
}

function readUpdateBackupManifest() {
  const manifestPath = resolveUpdateBackupManifestPath();
  if (!fs.existsSync(manifestPath)) {
    return null;
  }

  try {
    const manifestText = fs.readFileSync(manifestPath, 'utf-8');
    const manifest = JSON.parse(manifestText);
    if (!manifest || typeof manifest !== 'object') {
      return null;
    }
    return manifest;
  } catch (_error) {
    return null;
  }
}

function writeUpdateBackupManifest(manifest) {
  ensureDirectory(resolveUpdateBackupRoot());
  fs.writeFileSync(resolveUpdateBackupManifestPath(), JSON.stringify(manifest, null, 2), 'utf-8');
}

function cleanupUpdateBackupRoot() {
  try {
    fs.rmSync(resolveUpdateBackupRoot(), { recursive: true, force: true });
  } catch (_error) {
  }
}

function normalizeBackupFileList(manifest) {
  if (manifest && Array.isArray(manifest.files) && manifest.files.length) {
    return manifest.files.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim());
  }
  return DESKTOP_UPDATE_RUNTIME_RELATIVE_FILES.slice();
}

function copyRuntimeStatePathSync(source, target) {
  const stats = fs.statSync(source);
  if (stats.isDirectory()) {
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(target, { recursive: true });
    fs.readdirSync(source, { withFileTypes: true }).forEach((entry) => {
      copyRuntimeStatePathSync(path.join(source, entry.name), path.join(target, entry.name));
    });
    return;
  }

  if (!stats.isFile()) {
    throw new Error(`unsupported runtime state path type: ${source}`);
  }

  ensureDirectory(path.dirname(target));
  fs.rmSync(target, { recursive: true, force: true });
  fs.copyFileSync(source, target);
}

function backupPackagedRuntimeState() {
  if (!isWindowsNsisInstalledApp()) {
    return;
  }

  const runtimeEntries = resolveRuntimeFileEntries();
  const backedUpFiles = [];

  cleanupUpdateBackupRoot();
  ensureDirectory(resolveUpdateBackupRoot());

  runtimeEntries.forEach(({ relativePath, absolutePath, backupPath }) => {
    if (!fs.existsSync(absolutePath)) {
      return;
    }
    copyRuntimeStatePathSync(absolutePath, backupPath);
    backedUpFiles.push(relativePath);
  });

  if (!backedUpFiles.length) {
    return;
  }

  writeUpdateBackupManifest({
    backedAt: new Date().toISOString(),
    appVersion: resolveDesktopVersion(),
    files: backedUpFiles,
  });
}

function restorePackagedRuntimeStateFromBackup() {
  const result = {
    backupRoot: null,
    restored: [],
    failed: [],
    skipped: [],
  };

  if (!isWindowsNsisInstalledApp()) {
    return result;
  }

  const manifest = readUpdateBackupManifest();
  if (!manifest) {
    return result;
  }

  const backupRoot = resolveUpdateBackupRoot();
  result.backupRoot = backupRoot;
  const backupAppVersion = normalizeVersionString(manifest.appVersion);
  const currentAppVersion = normalizeVersionString(resolveDesktopVersion());
  const versionComparison = backupAppVersion && currentAppVersion
    ? compareVersions(backupAppVersion, currentAppVersion)
    : null;
  const isSameAppVersion = Boolean(
    backupAppVersion &&
    currentAppVersion &&
    (versionComparison === 0 || (versionComparison === null && backupAppVersion === currentAppVersion))
  );
  if (isSameAppVersion) {
    const reason = `stale backup target ${backupAppVersion} was discarded because current version did not change`;
    result.skipped.push(reason);
    cleanupUpdateBackupRoot();
    logLine(`[update] discarded runtime restore backup because app version did not change after update attempt: ${currentAppVersion}`);
    return result;
  }

  const appDir = resolveAppDir();
  const runtimeEntries = resolveRuntimeFileEntries(appDir);
  const relativeFiles = normalizeBackupFileList(manifest);
  const failedRelativeFiles = [];

  try {
    relativeFiles.forEach((relativePath) => {
      try {
        const entry = runtimeEntries.find((candidate) => candidate.relativePath === relativePath);
        const source = path.join(backupRoot, relativePath);
        const target = entry ? entry.absolutePath : path.join(appDir, relativePath);
        if (!fs.existsSync(source)) {
          return;
        }
        copyRuntimeStatePathSync(source, target);
        result.restored.push(relativePath);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failedRelativeFiles.push(relativePath);
        result.failed.push(`${relativePath} (${message})`);
      }
    });
  } finally {
    if (!result.failed.length) {
      cleanupUpdateBackupRoot();
    } else {
      try {
        writeUpdateBackupManifest({
          ...manifest,
          files: failedRelativeFiles,
          lastRestoreFailedAt: new Date().toISOString(),
        });
      } catch (error) {
        logLine(`[update] failed to rewrite pending restore manifest: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  if (result.restored.length) {
    console.log(`[update] restored runtime files from backup: ${result.restored.join(', ')}`);
  }
  if (result.failed.length) {
    logLine(`[update] skipped runtime restore files after copy failure: ${result.failed.join(', ')}`);
  }
  if (result.skipped.length) {
    logLine(`[update] skipped runtime restore: ${result.skipped.join(', ')}`);
  }

  return result;
}

function migrateMacPackagedRuntimeState() {
  const result = {
    sourceDir: null,
    targetDir: null,
    migrated: [],
    skipped: [],
    failed: [],
  };

  if (!app.isPackaged || !isMac) {
    return result;
  }

  const sourceDir = resolvePackagedExeDir();
  const targetDir = resolveAppDir();
  result.sourceDir = sourceDir;
  result.targetDir = targetDir;

  if (sourceDir === targetDir || !fs.existsSync(sourceDir)) {
    return result;
  }

  DESKTOP_UPDATE_RUNTIME_RELATIVE_FILES.forEach((relativePath) => {
    const source = path.join(sourceDir, relativePath);
    const target = path.join(targetDir, relativePath);

    if (!fs.existsSync(source)) {
      return;
    }
    if (fs.existsSync(target)) {
      result.skipped.push(relativePath);
      return;
    }

    try {
      copyRuntimeStatePathSync(source, target);
      result.migrated.push(relativePath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.failed.push(`${relativePath} (${message})`);
    }
  });

  return result;
}

function resolveBackendPath() {
  if (process.env.DSA_BACKEND_PATH) {
    return process.env.DSA_BACKEND_PATH;
  }

  if (app.isPackaged) {
    const backendDir = path.join(process.resourcesPath, 'backend');
    const exeName = isWindows ? 'stock_analysis.exe' : 'stock_analysis';
    const oneDirPath = path.join(backendDir, 'stock_analysis', exeName);
    if (fs.existsSync(oneDirPath)) {
      return oneDirPath;
    }
    return path.join(backendDir, exeName);
  }

  return null;
}

function extendMacDesktopBackendPath(rawPath) {
  if (!isMac) {
    return rawPath;
  }

  const seen = new Set();
  const entries = String(rawPath || '')
    .split(DESKTOP_BACKEND_PATH_DELIMITER)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .filter((entry) => {
      if (seen.has(entry)) {
        return false;
      }
      seen.add(entry);
      return true;
    });

  [...MAC_DESKTOP_CLI_PATH_ENTRIES, ...MAC_DESKTOP_SYSTEM_PATH_ENTRIES].forEach((entry) => {
    if (!seen.has(entry)) {
      entries.push(entry);
      seen.add(entry);
    }
  });

  return entries.join(DESKTOP_BACKEND_PATH_DELIMITER);
}

function normalizeBackendHost(value, fallback = '') {
  const normalized = String(value || '').trim();
  return normalized || fallback;
}

function normalizeBackendBindHost(value, fallback = DESKTOP_BACKEND_DEFAULT_HOST) {
  const host = normalizeBackendHost(value, fallback);
  const lowerHost = host.toLowerCase();
  if (lowerHost === '*') {
    return '0.0.0.0';
  }
  if (lowerHost === '[::]') {
    return '::';
  }
  return host;
}

function hasOwnValue(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function parseQuotedEnvValue(value, quote) {
  let result = '';
  for (let index = 1; index < value.length; index += 1) {
    const char = value[index];
    if (char === quote) {
      if (quote === '"') {
        return result.replace(/\\([nrt"\\$])/g, (_match, escaped) => {
          if (escaped === 'n') {
            return '\n';
          }
          if (escaped === 'r') {
            return '\r';
          }
          if (escaped === 't') {
            return '\t';
          }
          return escaped;
        });
      }
      return result.replace(/\\'/g, "'").replace(/\\\\/g, '\\');
    }
    result += char;
  }

  return value.trim();
}

function parseEnvScalarValue(rawValue) {
  const value = String(rawValue || '').trimStart();
  if (!value) {
    return '';
  }

  const quote = value[0];
  if (quote === '"' || quote === "'") {
    return parseQuotedEnvValue(value, quote);
  }

  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '#' && (index === 0 || /\s/.test(value[index - 1]))) {
      return value.slice(0, index).trim();
    }
  }

  return value.trim();
}

function expandEnvReferences(value, values = {}, sourceEnv = process.env) {
  return String(value || '').replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-(.*?))?\}/g,
    (_match, name, defaultValue) => {
      if (hasOwnValue(sourceEnv, name)) {
        return String(sourceEnv[name]);
      }
      if (hasOwnValue(values, name)) {
        return String(values[name]);
      }
      return defaultValue === undefined ? '' : defaultValue;
    }
  );
}

function readEnvFileValues(envFile, sourceEnv = process.env) {
  if (!envFile || !fs.existsSync(envFile)) {
    return {};
  }

  let content = '';
  try {
    content = fs.readFileSync(envFile, 'utf-8');
  } catch (_error) {
    return {};
  }

  const values = {};
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\uFEFF?\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) {
      continue;
    }
    values[match[1]] = expandEnvReferences(
      parseEnvScalarValue(match[2]),
      values,
      sourceEnv
    );
  }

  return values;
}

function readEnvFileValue(envFile, key, sourceEnv = process.env) {
  const values = readEnvFileValues(envFile, sourceEnv);
  return hasOwnValue(values, key) ? values[key] : null;
}

function resolveBackendBindHost({
  envFile,
  sourceEnv = process.env,
  fallback = DESKTOP_BACKEND_DEFAULT_HOST,
} = {}) {
  const sourceHost = normalizeBackendHost(sourceEnv.WEBUI_HOST);
  if (sourceHost) {
    return normalizeBackendBindHost(sourceHost, fallback);
  }

  const envFileHost = normalizeBackendHost(readEnvFileValue(envFile, 'WEBUI_HOST', sourceEnv));
  return normalizeBackendBindHost(envFileHost || fallback, fallback);
}

function resolveDesktopConnectHost(bindHost) {
  const host = normalizeBackendBindHost(bindHost, DESKTOP_BACKEND_DEFAULT_HOST);
  if (PUBLIC_BIND_HOSTS.has(host.toLowerCase())) {
    return DESKTOP_BACKEND_DEFAULT_HOST;
  }
  return host;
}

function formatUrlHost(host) {
  const normalized = normalizeBackendHost(host, DESKTOP_BACKEND_DEFAULT_HOST);
  if (normalized.startsWith('[') && normalized.endsWith(']')) {
    return normalized;
  }
  return normalized.includes(':') ? `[${normalized}]` : normalized;
}

function buildBackendUrl(host, port, pathname = '/') {
  const url = new URL(`http://${formatUrlHost(host)}:${port}/`);
  url.pathname = pathname;
  return url.toString();
}

function buildBackendArgs({ host, port }) {
  return [
    '--serve-only',
    '--host',
    normalizeBackendBindHost(host, DESKTOP_BACKEND_DEFAULT_HOST),
    '--port',
    String(port),
  ];
}

function buildBackendEnvironment({
  envFile,
  dbPath,
  logDir,
  port = null,
  host = null,
  sourceEnv = process.env,
}) {
  const selectedPort = Number(port);
  const selectedHost = normalizeBackendBindHost(
    normalizeBackendHost(host) || resolveBackendBindHost({ envFile, sourceEnv }),
    DESKTOP_BACKEND_DEFAULT_HOST
  );
  const env = {
    ...sourceEnv,
    DSA_DESKTOP_MODE: 'true',
    ENV_FILE: envFile,
    DATABASE_PATH: dbPath,
    STOCKMASTER_TASK_STATE_PATH: path.join(path.dirname(dbPath), 'unfinished-analysis-tasks.json'),
    STOCKMASTER_SHARED_FETCHER_CACHE: 'true',
    LOG_DIR: logDir,
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
    WEBUI_HOST: selectedHost,
    WEBUI_ENABLED: 'false',
    BOT_ENABLED: 'false',
    DINGTALK_STREAM_ENABLED: 'false',
    FEISHU_STREAM_ENABLED: 'false',
  };

  if (Number.isInteger(selectedPort) && selectedPort >= 1 && selectedPort <= 65535) {
    env.WEBUI_PORT = String(selectedPort);
  }

  if (isMac) {
    env.PATH = extendMacDesktopBackendPath(sourceEnv.PATH);
  }

  return env;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function ensureDirectory(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function initLogging() {
  const appDir = resolveAppDir();
  logFilePath = path.join(appDir, 'logs', 'desktop.log');
  
  // 确保日志目录存在
  const logDir = path.dirname(logFilePath);
  ensureDirectory(logDir);
  
  logLine('Desktop app starting');
}

function logLine(message) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${message}\n`;
  try {
    if (logFilePath) {
      fs.appendFileSync(logFilePath, line, 'utf-8');
    }
  } catch (error) {
    console.error(error);
  }
  console.log(line.trim());
}

function decodeBackendOutput(data, decoder) {
  if (typeof data === 'string') {
    return data.trim();
  }
  if (!Buffer.isBuffer(data)) {
    return String(data).trim();
  }

  let decoded = decoder.decode(data, { stream: true });

  // Windows 控制台 / 子进程有时仍会吐出本地代码页字节，优先在明显乱码时回退到 GBK。
  if (isWindows && decoded.includes('\uFFFD')) {
    try {
      decoded = new TextDecoder('gbk', { fatal: false }).decode(data, { stream: true });
    } catch (_error) {
    }
  }

  return decoded.trim();
}

function formatCommand(command, args = []) {
  return [command, ...args]
    .map((part) => {
      const value = String(part);
      return value.includes(' ') ? `"${value}"` : value;
    })
    .join(' ');
}

function resolvePythonPath() {
  return process.env.DSA_PYTHON || 'python';
}

function ensureEnvFile(envPath) {
  if (fs.existsSync(envPath)) {
    return;
  }

  const envExample = resolveEnvExamplePath();
  if (fs.existsSync(envExample)) {
    fs.copyFileSync(envExample, envPath);
    return;
  }

  fs.writeFileSync(envPath, '# Configure your API keys and stock list here.\n', 'utf-8');
}

function findAvailablePort(startPort = 8000, endPort = 8100, host = DESKTOP_BACKEND_DEFAULT_HOST) {
  const bindHost = normalizeBackendBindHost(host, DESKTOP_BACKEND_DEFAULT_HOST);
  return new Promise((resolve, reject) => {
    const tryPort = (port) => {
      if (port > endPort) {
        reject(new Error('No available port'));
        return;
      }

      const server = net.createServer();
      server.once('error', () => {
        tryPort(port + 1);
      });
      server.once('listening', () => {
        server.close(() => resolve(port));
      });
      server.listen(port, bindHost);
    };

    tryPort(startPort);
  });
}

function waitForHealth(
  url,
  timeoutMs = 60000,
  intervalMs = 250,
  requestTimeoutMs = 1500,
  shouldAbort = null,
  onProgress = null
) {
  const start = Date.now();
  let attempts = 0;

  return new Promise((resolve, reject) => {
    let settled = false;
    let retryTimer = null;
    let activeRequest = null;

    const emitProgress = (payload) => {
      if (typeof onProgress !== 'function') {
        return;
      }
      try {
        onProgress(payload);
      } catch (_error) {
      }
    };

    const finish = (error, result) => {
      if (settled) {
        return;
      }
      settled = true;

      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }

      if (activeRequest && !activeRequest.destroyed) {
        activeRequest.destroy();
      }

      if (error) {
        emitProgress({
          type: 'final_error',
          elapsedMs: Date.now() - start,
          attempts,
          message: error.message,
        });
      }

      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    };

    const scheduleNext = () => {
      if (settled) {
        return;
      }
      retryTimer = setTimeout(attempt, intervalMs);
    };

    const attempt = () => {
      if (settled) {
        return;
      }

      if (typeof shouldAbort === 'function') {
        const abortReason = shouldAbort();
        if (abortReason) {
          emitProgress({
            type: 'aborted',
            elapsedMs: Date.now() - start,
            attempts,
            reason: abortReason,
          });
          finish(new Error(`Health check aborted: ${abortReason}`));
          return;
        }
      }

      const elapsedMs = Date.now() - start;
      if (elapsedMs > timeoutMs) {
        emitProgress({
          type: 'total_timeout',
          elapsedMs,
          attempts,
          timeoutMs,
        });
        finish(new Error(`Health check timeout after ${elapsedMs}ms`));
        return;
      }

      attempts += 1;
      emitProgress({
        type: 'probe_start',
        elapsedMs,
        attempts,
      });

      activeRequest = http.get(url, (res) => {
        if (settled) {
          return;
        }

        res.resume();
        if (res.statusCode === 200) {
          const readyElapsedMs = Date.now() - start;
          emitProgress({
            type: 'ready',
            elapsedMs: readyElapsedMs,
            attempts,
          });
          finish(null, { elapsedMs: readyElapsedMs, attempts });
          return;
        }

        emitProgress({
          type: 'probe_status',
          elapsedMs: Date.now() - start,
          attempts,
          statusCode: res.statusCode,
        });
        scheduleNext();
      });

      activeRequest.setTimeout(requestTimeoutMs, () => {
        emitProgress({
          type: 'probe_timeout',
          elapsedMs: Date.now() - start,
          attempts,
          requestTimeoutMs,
        });
        activeRequest.destroy(new Error(`Health probe request timeout after ${requestTimeoutMs}ms`));
      });

      activeRequest.on('error', (error) => {
        if (settled) {
          return;
        }

        emitProgress({
          type: 'probe_error',
          elapsedMs: Date.now() - start,
          attempts,
          errorCode: error.code || 'unknown',
          errorMessage: error.message,
        });
        scheduleNext();
      });
    };

    attempt();
  });
}

function startBackend({ port, envFile, dbPath, logDir, host = null, sourceRoot = '' }) {
  const backendPath = resolveBackendPath();
  backendStartError = null;
  const launchStartedAt = Date.now();
  const bindHost = normalizeBackendBindHost(
    normalizeBackendHost(host) || resolveBackendBindHost({ envFile }),
    DESKTOP_BACKEND_DEFAULT_HOST
  );

  const env = buildBackendEnvironment({ envFile, dbPath, logDir, port, host: bindHost });

  const args = buildBackendArgs({ host: bindHost, port });
  let launchMode = '';
  let launchCommand = '';
  let launchCwd = '';

  if (backendPath && !sourceRoot) {
    if (!fs.existsSync(backendPath)) {
      throw new Error(`Backend executable not found: ${backendPath}`);
    }
    launchMode = 'packaged';
    launchCommand = formatCommand(backendPath, args);
    launchCwd = path.dirname(backendPath);
    backendProcess = spawn(backendPath, args, {
      env,
      cwd: launchCwd,
      stdio: 'pipe',
      windowsHide: true,
    });
  } else {
    const pythonPath = resolvePythonPath();
    const runtimeSourceRoot = sourceRoot ? path.resolve(sourceRoot) : appRootDev;
    const scriptPath = path.join(runtimeSourceRoot, 'main.py');
    if (!fs.existsSync(scriptPath)) throw new Error(`Backend source entry not found: ${scriptPath}`);
    const pythonArgs = ['-X', 'utf8', scriptPath, ...args];
    launchMode = 'development';
    launchCommand = formatCommand(pythonPath, pythonArgs);
    launchCwd = runtimeSourceRoot;
    backendProcess = spawn(pythonPath, pythonArgs, {
      env,
      cwd: launchCwd,
      stdio: 'pipe',
      windowsHide: true,
    });
  }

  if (backendProcess) {
    let firstStdoutLogged = false;
    let firstStderrLogged = false;
    const stdoutDecoder = new TextDecoder('utf-8', { fatal: false });
    const stderrDecoder = new TextDecoder('utf-8', { fatal: false });

    backendProcess.once('spawn', () => {
      logLine(`[backend] spawned pid=${backendProcess.pid} in ${Date.now() - launchStartedAt}ms`);
    });
    backendProcess.on('error', (error) => {
      backendStartError = error;
      logLine(`[backend] failed to start: ${error.message}`);
    });
    backendProcess.stdout.on('data', (data) => {
      if (!firstStdoutLogged) {
        firstStdoutLogged = true;
        logLine(`[backend] first stdout after ${Date.now() - launchStartedAt}ms`);
      }
      logLine(`[backend] ${decodeBackendOutput(data, stdoutDecoder)}`);
    });
    backendProcess.stderr.on('data', (data) => {
      if (!firstStderrLogged) {
        firstStderrLogged = true;
        logLine(`[backend] first stderr after ${Date.now() - launchStartedAt}ms`);
      }
      logLine(`[backend] ${decodeBackendOutput(data, stderrDecoder)}`);
    });
    backendProcess.on('exit', (code, signal) => {
      logLine(`[backend] exited with code ${code}, signal ${signal || 'none'}`);
    });
  }

  return {
    mode: launchMode,
    command: launchCommand,
    cwd: launchCwd,
  };
}

function waitForBackendExit(processRef, timeoutMs = 5000) {
  if (!processRef || processRef.exitCode !== null || processRef.signalCode) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    let onExit = null;

    const done = (exited) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (onExit) {
        processRef.removeListener('exit', onExit);
      }
      resolve(exited || processRef.exitCode !== null || Boolean(processRef.signalCode));
    };

    onExit = () => done(true);

    timer = setTimeout(() => {
      done(false);
    }, timeoutMs);

    processRef.once('exit', onExit);
  });
}

function __setBackendProcessForTest(processRef = null) {
  backendProcess = processRef;
}

function clearBackendProcessIfCurrent(processRef) {
  if (backendProcess === processRef) {
    backendProcess = null;
  }
}

function stopBackend() {
  if (!backendProcess) {
    return Promise.resolve();
  }
  const processToStop = backendProcess;
  if (processToStop.exitCode !== null || processToStop.signalCode) {
    clearBackendProcessIfCurrent(processToStop);
    return Promise.resolve();
  }

  const waitAndClear = () => waitForBackendExit(processToStop, 10000)
    .then((exited) => {
      if (!exited) {
        return;
      }
      clearBackendProcessIfCurrent(processToStop);
    });

  if (isWindows) {
    spawn('taskkill', ['/PID', String(processToStop.pid), '/T', '/F'], { windowsHide: true }).on('error', () => {
    });
    return waitAndClear();
  }

  if (!processToStop.killed) {
    processToStop.kill('SIGTERM');
  }
  setTimeout(() => {
    if (processToStop.killed || processToStop.exitCode !== null || processToStop.signalCode) {
      return;
    }
    try {
      processToStop.kill('SIGKILL');
    } catch (_error) {
    }
  }, 3000);

  return waitAndClear();
}

function readBackendTaskState() {
  if (!backendRuntimeContext?.connectHost || !backendRuntimeContext?.port) {
    return Promise.reject(new Error('后端运行信息不可用，无法安全同步。'));
  }
  const url = new URL(buildBackendUrl(
    backendRuntimeContext.connectHost,
    backendRuntimeContext.port,
    '/api/v1/analysis/tasks',
  ));
  url.searchParams.set('limit', '100');
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode !== 200) {
          reject(new Error(`无法确认分析任务状态，HTTP ${response.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error('分析任务状态返回格式无效'));
        }
      });
    });
    request.setTimeout(5000, () => request.destroy(new Error('检查分析任务状态超时')));
    request.on('error', reject);
  });
}

async function assertBackendIdleForAlgorithmSync() {
  const payload = await readBackendTaskState();
  const tasks = Array.isArray(payload?.tasks) ? payload.tasks : [];
  const active = tasks.filter((task) => ['pending', 'processing', 'cancel_requested'].includes(task?.status));
  if (active.length) throw new Error(`当前有 ${active.length} 个分析任务尚未结束，请完成或停止任务后再同步。`);
}

async function healthCheckCurrentBackend() {
  const url = buildBackendUrl(
    backendRuntimeContext.connectHost,
    backendRuntimeContext.port,
    '/api/health',
  );
  try {
    await waitForHealth(
      url,
      60_000,
      250,
      1500,
      () => {
        if (backendStartError) return `backend start error: ${backendStartError.message}`;
        if (!backendProcess) return 'backend process is unavailable';
        if (backendProcess.exitCode !== null) return `backend exited with code ${backendProcess.exitCode}`;
        return null;
      },
    );
    return true;
  } catch {
    return false;
  }
}

async function syncAlgorithmUpdate() {
  if (algorithmSyncInFlight) return algorithmSyncInFlight;
  algorithmSyncInFlight = (async () => {
    if (!algorithmUpdateMonitor) throw new Error('算法更新监控尚未启用。');
    const initial = algorithmUpdateMonitor.getState();
    if (!initial.algorithmUpdateAvailable || !initial.candidateCommit) throw new Error('当前没有可同步的后端算法更新。');
    if (app.isPackaged) throw new Error('当前安装包使用编译后端，选择性算法同步将在正式安装包阶段启用。请先使用本地试运行版同步。');
    if (!backendRuntimeContext) throw new Error('后端运行信息尚未准备完成。');

    const commit = initial.candidateCommit;
    const eligiblePaths = [...(initial.candidatePaths || [])];
    const dependencyPaths = [...(initial.candidateDependencyPaths || [])];
    const removedPaths = [...(initial.candidateRemovedPaths || [])];
    const removedSet = new Set(removedPaths);
    const downloadPaths = [...eligiblePaths, ...dependencyPaths].filter((file) => !removedSet.has(file));
    const stagingRoot = path.join(app.getPath('userData'), 'stockmaster-algorithm-update', 'staging');
    const operationRoot = path.join(stagingRoot, `sync-${commit.slice(0, 12)}-${Date.now()}`);
    const archiveRoot = path.join(operationRoot, 'archive');
    const localBaselineArchiveRoot = path.join(operationRoot, 'local-baseline');
    const localUpstreamArchiveRoot = path.join(operationRoot, 'local-upstream');
    const currentRoot = path.resolve(backendRuntimeContext.sourceRoot || '');
    if (
      !backendRuntimeContext.sourceRoot
      || !fs.existsSync(path.join(currentRoot, 'main.py'))
      || !fs.existsSync(path.join(currentRoot, 'server.py'))
    ) {
      throw new Error('当前后端源码目录已失效，请重启 StockMaster 后再同步。');
    }

    try {
      await assertBackendIdleForAlgorithmSync();
      algorithmUpdateMonitor.setSyncState({ syncStatus: 'downloading', syncMessage: '正在下载已确认的后端算法文件' });
      await fs.promises.mkdir(archiveRoot, { recursive: true });
      await downloadUpstreamFiles({ commit, paths: downloadPaths, destinationRoot: archiveRoot });

      const localBaselineCommit = resolveStockMasterBaselineCommit();
      if (!/^[0-9a-f]{40}$/i.test(localBaselineCommit)) {
        throw new Error('StockMaster 本地补丁缺少有效的上游基线提交，已停止同步以避免覆盖本地强需求。');
      }
      const localOverlayPaths = STOCKMASTER_BACKEND_ADAPTER_FILES
        .map((file) => file.split(path.sep).join('/'));
      const localOverlaySet = new Set(localOverlayPaths);
      const cumulativeCompare = await fetchUpstreamCompare({ currentCommit: localBaselineCommit });
      if (cumulativeCompare.headCommit && cumulativeCompare.headCommit !== commit) {
        throw new Error('上游 main 在确认后又发生变化，请重新检查更新后再同步。');
      }
      if (cumulativeCompare.filesTruncated) {
        throw new Error('上游累计变更超过安全合并上限，请先人工刷新 StockMaster 上游基线。');
      }
      const localChangeStatuses = {};
      const localRenameTargets = {};
      for (const file of cumulativeCompare.changedFiles || []) {
        if (file.status === 'renamed' && localOverlaySet.has(file.previousPath)) {
          localChangeStatuses[file.previousPath] = 'renamed';
          localRenameTargets[file.previousPath] = file.path;
        } else if (localOverlaySet.has(file.path)) {
          localChangeStatuses[file.path] = file.status;
        }
      }
      const localBaselinePaths = [];
      const localUpstreamPaths = [];
      for (const [file, status] of Object.entries(localChangeStatuses)) {
        if (['modified', 'removed', 'renamed'].includes(status)) localBaselinePaths.push(file);
        if (status === 'renamed') localUpstreamPaths.push(localRenameTargets[file]);
        else if (['modified', 'added', 'copied'].includes(status)) localUpstreamPaths.push(file);
      }
      if (localBaselinePaths.length) {
        await fs.promises.mkdir(localBaselineArchiveRoot, { recursive: true });
        await downloadUpstreamFiles({
          commit: localBaselineCommit,
          paths: localBaselinePaths,
          destinationRoot: localBaselineArchiveRoot,
        });
      }
      if (localUpstreamPaths.length) {
        await fs.promises.mkdir(localUpstreamArchiveRoot, { recursive: true });
        await downloadUpstreamFiles({
          commit,
          paths: localUpstreamPaths,
          destinationRoot: localUpstreamArchiveRoot,
        });
      }

      algorithmUpdateMonitor.setSyncState({ syncStatus: 'validating', syncMessage: '正在三方合并上游算法与 StockMaster 本地强需求' });
      logLine(
        `[algorithm-update] staging current runtime=${currentRoot}; `
        + `main.py=${fs.existsSync(path.join(currentRoot, 'main.py'))}; `
        + `server.py=${fs.existsSync(path.join(currentRoot, 'server.py'))}`,
      );
      const staged = await stageBackendCandidate({
        currentRoot,
        archiveRoot,
        stagingRoot: operationRoot,
        eligiblePaths,
        dependencyPaths,
        removedPaths,
        localRoot: appRootDev,
        localOverlayPaths,
        localBaselineRoot: localBaselineArchiveRoot,
        localUpstreamRoot: localUpstreamArchiveRoot,
        localChangeStatuses,
        localRenameTargets,
        localBaselineCommit,
        candidateCommit: commit,
      });
      logLine(
        `[algorithm-update] candidate ready=${staged.candidateRoot}; `
        + `main.py=${fs.existsSync(path.join(staged.candidateRoot, 'main.py'))}; `
        + `server.py=${fs.existsSync(path.join(staged.candidateRoot, 'server.py'))}`,
      );
      logLine(
        `[algorithm-update] merge policy=${staged.mergeSummary.policy}; `
        + `merged=${staged.mergeSummary.mergedPaths.length}; `
        + `local_conflicts=${staged.mergeSummary.conflictPaths.length}; `
        + `conflict_paths=${staged.mergeSummary.conflictPaths.join(',') || 'none'}`,
      );
      await fs.promises.mkdir(path.join(operationRoot, 'validation-data'), { recursive: true });
      await fs.promises.mkdir(path.join(operationRoot, 'validation-logs'), { recursive: true });
      const validationEnv = buildBackendEnvironment({
        ...backendRuntimeContext,
        dbPath: path.join(operationRoot, 'validation-data', 'stock_analysis.db'),
        logDir: path.join(operationRoot, 'validation-logs'),
      });
      await validatePythonCandidate({
        candidateRoot: staged.candidateRoot,
        changedPaths: [...new Set([
          ...eligiblePaths,
          ...dependencyPaths,
          ...localOverlayPaths.map((file) => localRenameTargets[file] || file),
        ])].filter((file) => !removedSet.has(file) || staged.mergeSummary.conflictPaths.includes(file)),
        pythonPath: resolvePythonPath(),
        env: validationEnv,
      });

      algorithmUpdateMonitor.setSyncState({ syncStatus: 'activating', syncMessage: '正在切换后端并执行健康检查' });
      const runtimeRoot = resolveAlgorithmRuntimeRoot();
      await ensureCurrentPointer({
        runtimeRoot,
        pointer: { commit: initial.currentCommit, path: currentRoot },
      });
      const pointer = await activateCandidate({
        runtimeRoot,
        commit,
        candidatePath: staged.candidateRoot,
        stopBackend,
        startBackend: async (sourceRoot) => {
          activeBackendSourceRoot = sourceRoot;
          backendRuntimeContext.sourceRoot = sourceRoot;
          startBackend({ ...backendRuntimeContext, sourceRoot });
        },
        healthCheck: healthCheckCurrentBackend,
        metadata: {
          mergePolicy: staged.mergeSummary.policy,
          localBaselineCommit,
          localMergedPaths: staged.mergeSummary.mergedPaths,
          localConflictPaths: staged.mergeSummary.conflictPaths,
        },
      });
      activeBackendSourceRoot = pointer.path;
      backendRuntimeContext.sourceRoot = pointer.path;
      backendRuntimeContext.algorithmCommit = commit;
      backendRuntimeContext.algorithmAppliedCommit = commit;
      backendRuntimeContext.algorithmAppliedAt = pointer.activatedAt;
      const state = algorithmUpdateMonitor.markApplied(commit, {
        localBaselineCommit,
        mergeSummary: staged.mergeSummary,
      });
      if (mainWindow && !mainWindow.isDestroyed()) {
        await mainWindow.loadURL(buildMainPageUrl(
          backendRuntimeContext.port,
          Date.now(),
          backendRuntimeContext.connectHost,
        ));
      }
      return state;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      algorithmUpdateMonitor.setSyncState({ syncStatus: 'failed', syncMessage: message });
      throw error;
    } finally {
      try { await fs.promises.rm(operationRoot, { recursive: true, force: true }); } catch { /* best effort staging cleanup */ }
    }
  })();
  try {
    return await algorithmSyncInFlight;
  } finally {
    algorithmSyncInFlight = null;
  }
}

function resolveDesktopVersion() {
  return String(app.getVersion() || '').trim();
}

function buildMainPageUrl(port, timestamp = Date.now(), host = DESKTOP_BACKEND_DEFAULT_HOST) {
  const url = new URL(buildBackendUrl(host, port, '/'));
  url.searchParams.set('desktop_version', resolveDesktopVersion() || 'unknown');
  url.searchParams.set('cache_bust', String(timestamp));
  return url.toString();
}

function buildDesktopShareImageUrl(pageUrl, recordId, expectedBackendOrigin = '') {
  if (!Number.isSafeInteger(recordId) || recordId <= 0) {
    throw new Error('Invalid share image record ID');
  }

  let page;
  try {
    page = new URL(pageUrl);
  } catch (_error) {
    throw new Error('Desktop backend URL is unavailable');
  }

  let expectedOrigin = page.origin;
  if (expectedBackendOrigin) {
    try {
      expectedOrigin = new URL(expectedBackendOrigin).origin;
    } catch (_error) {
      throw new Error('Desktop backend origin is invalid');
    }
  }
  if (page.protocol !== 'http:' || !page.port || page.origin !== expectedOrigin) {
    throw new Error('Desktop share images require the configured backend origin');
  }

  return new URL(
    `/api/v1/history/${recordId}/share-image-html`,
    page.origin
  ).toString();
}

async function renderDesktopShareImage(
  recordId,
  {
    sourceWindow = mainWindow,
    BrowserWindowClass = BrowserWindow,
    backendOrigin = '',
  } = {}
) {
  if (!sourceWindow || sourceWindow.isDestroyed() || !sourceWindow.webContents) {
    throw new Error('Desktop window is unavailable');
  }

  const targetUrl = buildDesktopShareImageUrl(
    sourceWindow.webContents.getURL(),
    recordId,
    backendOrigin
  );
  let renderWindow = null;
  try {
    renderWindow = new BrowserWindowClass({
      show: false,
      width: DESKTOP_SHARE_IMAGE_WIDTH,
      height: DESKTOP_SHARE_IMAGE_INITIAL_HEIGHT,
      ...(isMac ? { enableLargerThanScreen: true } : {}),
      useContentSize: true,
      backgroundColor: '#eef4fd',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    renderWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    renderWindow.webContents.on('will-navigate', (event, navigationUrl) => {
      if (navigationUrl !== targetUrl) {
        event.preventDefault();
      }
    });

    await renderWindow.loadURL(targetUrl);
    const pageMetrics = await renderWindow.webContents.executeJavaScript(`({
      contentType: document.contentType,
      width: Math.ceil(Math.max(document.documentElement.scrollWidth, document.body.scrollWidth)),
      height: Math.ceil(Math.max(document.documentElement.scrollHeight, document.body.scrollHeight))
    })`);
    if (!pageMetrics || pageMetrics.contentType !== 'text/html') {
      throw new Error('Desktop share image source did not return HTML');
    }
    if (
      !Number.isFinite(pageMetrics.width)
      || pageMetrics.width !== DESKTOP_SHARE_IMAGE_WIDTH
      || !Number.isFinite(pageMetrics.height)
      || pageMetrics.height < 1
      || pageMetrics.height > DESKTOP_SHARE_IMAGE_MAX_HEIGHT
    ) {
      throw new Error(`Desktop share image has invalid dimensions: ${pageMetrics.width}x${pageMetrics.height}`);
    }

    renderWindow.setContentSize(DESKTOP_SHARE_IMAGE_WIDTH, pageMetrics.height);
    await renderWindow.webContents.executeJavaScript(
      'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))'
    );
    const image = await renderWindow.webContents.capturePage({
      x: 0,
      y: 0,
      width: DESKTOP_SHARE_IMAGE_WIDTH,
      height: pageMetrics.height,
    });
    if (!image || image.isEmpty()) {
      throw new Error('Desktop share image capture returned an empty image');
    }

    const png = image.toPNG();
    return png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength);
  } finally {
    if (renderWindow && !renderWindow.isDestroyed()) {
      renderWindow.destroy();
    }
  }
}

function isWindowsNsisInstalledApp() {
  if (!isWindows || !app.isPackaged) {
    return false;
  }

  const appDir = path.dirname(app.getPath('exe'));
  return fs.existsSync(path.join(appDir, 'Uninstall Daily Stock Analysis.exe'));
}

function getElectronAutoUpdater() {
  if (electronAutoUpdater !== undefined) {
    return electronAutoUpdater;
  }

  if (!isWindowsNsisInstalledApp()) {
    electronAutoUpdater = null;
    return electronAutoUpdater;
  }

  try {
    electronAutoUpdater = require('electron-updater').autoUpdater;
  } catch (error) {
    electronAutoUpdater = null;
    logLine(`[update] electron-updater unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }

  return electronAutoUpdater;
}

function canUseElectronAutoUpdater() {
  return Boolean(getElectronAutoUpdater());
}

function resolveReleasePageUrlForVersion(version) {
  const normalizedVersion = normalizeVersionString(version);
  if (!normalizedVersion) {
    return RELEASES_PAGE_URL;
  }
  return `${RELEASES_PAGE_URL}/tag/v${normalizedVersion}`;
}

function resolveUpdaterLatestVersion(updateInfo = {}) {
  return normalizeVersionString(updateInfo.version || updateInfo.tag || updateInfo.releaseName);
}

function buildElectronUpdaterState(status, updateInfo = {}, extraState = {}) {
  const latestVersion = normalizeVersionString(extraState.latestVersion || resolveUpdaterLatestVersion(updateInfo));
  return buildUpdateState({
    status,
    updateMode: UPDATE_MODE.AUTO,
    currentVersion: resolveDesktopVersion(),
    latestVersion,
    releaseUrl: resolveReleasePageUrlForVersion(latestVersion),
    publishedAt: typeof updateInfo.releaseDate === 'string' ? updateInfo.releaseDate : '',
    releaseName: typeof updateInfo.releaseName === 'string' ? updateInfo.releaseName : '',
    tagName: latestVersion ? `v${latestVersion}` : '',
    ...extraState,
  });
}

function sanitizeReleaseUrl(candidateUrl) {
  if (typeof candidateUrl !== 'string' || !candidateUrl.trim()) {
    return RELEASES_PAGE_URL;
  }

  try {
    const parsed = new URL(candidateUrl.trim());
    const allowedReleasePathPrefix = `/${GITHUB_OWNER}/${GITHUB_REPO}/releases`;
    const isGithubHost = parsed.origin === 'https://github.com';
    const isRepositoryReleasePath =
      parsed.pathname === allowedReleasePathPrefix ||
      parsed.pathname.startsWith(`${allowedReleasePathPrefix}/`);
    return isGithubHost && isRepositoryReleasePath ? parsed.toString() : RELEASES_PAGE_URL;
  } catch (_error) {
    return RELEASES_PAGE_URL;
  }
}

function broadcastDesktopUpdateState() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.webContents.send('desktop:update-state', desktopUpdateState);
}

function setDesktopUpdateState(nextState) {
  desktopUpdateState = buildUpdateState({
    currentVersion: resolveDesktopVersion(),
    ...nextState,
  });
  broadcastDesktopUpdateState();
  return desktopUpdateState;
}

async function maybePromptDesktopUpdate(state) {
  if (!state || state.status !== UPDATE_STATUS.UPDATE_AVAILABLE) {
    return;
  }
  if (state.updateMode === UPDATE_MODE.AUTO) {
    return;
  }
  if (!state.latestVersion || state.latestVersion === lastNotifiedUpdateVersion) {
    return;
  }
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  lastNotifiedUpdateVersion = state.latestVersion;
  const currentVersion = state.currentVersion || resolveDesktopVersion() || '当前版本';
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'info',
    buttons: ['稍后', '前往下载'],
    defaultId: 1,
    cancelId: 0,
    title: '发现新版本',
    message: `检测到桌面端新版本 ${state.latestVersion}`,
    detail: `当前版本 ${currentVersion}。新版本将跳转到 GitHub Releases 下载页，不会静默下载或自动安装。`,
    noLink: true,
  });

  if (result.response === 1) {
    await shell.openExternal(sanitizeReleaseUrl(state.releaseUrl));
  }
}

async function installDownloadedUpdate() {
  const updater = getElectronAutoUpdater();
  if (!updater) {
    throw new Error('当前运行模式不支持自动安装更新。');
  }
  if (desktopUpdateState?.status !== UPDATE_STATUS.UPDATE_DOWNLOADED) {
    throw new Error('更新尚未下载完成，无法自动安装。');
  }

  setDesktopUpdateState({
    status: UPDATE_STATUS.INSTALLING,
    updateMode: UPDATE_MODE.AUTO,
    latestVersion: desktopUpdateState?.latestVersion || '',
    releaseUrl: desktopUpdateState?.releaseUrl || RELEASES_PAGE_URL,
    message: '正在重启并安装更新...',
  });
  let backupRoot = null;
  try {
    logLine('[update] stop backend and backup runtime data before install');
    await stopBackend();
    backupRoot = resolveUpdateBackupRoot();
    cleanupUpdateBackupRoot();

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        backupPackagedRuntimeState();
        break;
      } catch (error) {
        if (attempt === 3) {
          setDesktopUpdateState({
            status: UPDATE_STATUS.ERROR,
            updateMode: UPDATE_MODE.AUTO,
            currentVersion: resolveDesktopVersion(),
            latestVersion: desktopUpdateState?.latestVersion || '',
            releaseUrl: desktopUpdateState?.releaseUrl || RELEASES_PAGE_URL,
            checkedAt: new Date().toISOString(),
            message: `更新安装准备失败：${error instanceof Error ? error.message : String(error)}`,
          });
          throw error;
        }

        await sleep(300 * attempt);
      }
    }

    logLine('[update] silent quit and install requested');
    updater.quitAndInstall(true, true);
    return true;
  } catch (error) {
    if (backupRoot) {
      cleanupUpdateBackupRoot();
    }
    logLine(`[update] install downloaded update failed: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

async function maybePromptInstallDownloadedUpdate(state) {
  if (!state || state.status !== UPDATE_STATUS.UPDATE_DOWNLOADED || state.updateMode !== UPDATE_MODE.AUTO) {
    return;
  }
  if (!state.latestVersion || state.latestVersion === lastPromptedInstallVersion) {
    return;
  }
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  lastPromptedInstallVersion = state.latestVersion;
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'info',
    buttons: ['稍后', '立即重启安装'],
    defaultId: 1,
    cancelId: 0,
    title: '更新已下载',
    message: `桌面端新版本 ${state.latestVersion} 已下载`,
    detail: '重启应用后会自动完成安装。未保存的设置草稿请先保存。',
    noLink: true,
  });

  if (result.response === 1) {
    try {
      await installDownloadedUpdate();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logLine(`[update] auto install prompt failed: ${message}`);
      setDesktopUpdateState({
        status: UPDATE_STATUS.ERROR,
        updateMode: UPDATE_MODE.AUTO,
        currentVersion: resolveDesktopVersion(),
        latestVersion: state.latestVersion || desktopUpdateState?.latestVersion || '',
        releaseUrl: state.releaseUrl || desktopUpdateState?.releaseUrl || RELEASES_PAGE_URL,
        checkedAt: new Date().toISOString(),
        message: `更新安装失败：${message}。可先保存草稿并前往下载页，或稍后重试。`,
      });
    }
  }
}

function configureElectronAutoUpdater() {
  const updater = getElectronAutoUpdater();
  if (!updater || electronAutoUpdaterConfigured) {
    return updater;
  }

  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = false;
  if (isWindows && app.isPackaged) {
    const installDirectory = path.dirname(app.getPath('exe'));
    if (installDirectory) {
      updater.installDirectory = installDirectory;
      logLine(`[update] auto updater install directory set to ${updater.installDirectory}`);
    }
  }

  updater.on('checking-for-update', () => {
    setDesktopUpdateState({
      status: UPDATE_STATUS.CHECKING,
      updateMode: UPDATE_MODE.AUTO,
      currentVersion: resolveDesktopVersion(),
      message: '正在检查桌面端更新...',
    });
  });

  updater.on('update-available', (info = {}) => {
    const latestVersion = resolveUpdaterLatestVersion(info) || '最新版本';
    const nextState = buildElectronUpdaterState(UPDATE_STATUS.UPDATE_AVAILABLE, info, {
      message: `发现新版本 ${latestVersion}，正在后台下载更新...`,
    });
    setDesktopUpdateState(nextState);
    logLine(`[update] auto update available latest=${nextState.latestVersion || 'unknown'}`);
  });

  updater.on('update-not-available', (info = {}) => {
    const nextState = buildElectronUpdaterState(UPDATE_STATUS.UP_TO_DATE, info, {
      message: '当前桌面端已是最新版本。',
    });
    setDesktopUpdateState(nextState);
    logLine(`[update] auto update not available current=${nextState.currentVersion || 'unknown'}`);
  });

  updater.on('download-progress', (progress = {}) => {
    const percent = normalizeDownloadPercent(progress.percent);
    const nextState = setDesktopUpdateState({
      status: UPDATE_STATUS.DOWNLOADING,
      updateMode: UPDATE_MODE.AUTO,
      latestVersion: desktopUpdateState?.latestVersion || '',
      releaseUrl: desktopUpdateState?.releaseUrl || RELEASES_PAGE_URL,
      downloadPercent: percent,
      downloadedBytes: progress.transferred,
      totalBytes: progress.total,
      message:
        percent === null
          ? '正在下载桌面端更新...'
          : `正在下载桌面端更新（${percent.toFixed(percent % 1 === 0 ? 0 : 1)}%）...`,
    });
    logLine(`[update] download progress percent=${nextState.downloadPercent ?? 'unknown'}`);
  });

  updater.on('update-downloaded', (info = {}) => {
    const latestVersion = resolveUpdaterLatestVersion(info) || desktopUpdateState?.latestVersion || '';
    const nextState = buildElectronUpdaterState(UPDATE_STATUS.UPDATE_DOWNLOADED, info, {
      latestVersion,
      downloadPercent: 100,
      message: latestVersion
        ? `新版本 ${latestVersion} 已下载，可重启应用完成安装。`
        : '新版本已下载，可重启应用完成安装。',
    });
    setDesktopUpdateState(nextState);
    logLine(`[update] downloaded latest=${nextState.latestVersion || 'unknown'}`);
    void maybePromptInstallDownloadedUpdate(nextState);
  });

  updater.on('error', (error) => {
    const message = error instanceof Error ? error.message : String(error);
    logLine(`[update] auto updater failed: ${message}`);
    setDesktopUpdateState({
      status: UPDATE_STATUS.ERROR,
      updateMode: UPDATE_MODE.AUTO,
      currentVersion: resolveDesktopVersion(),
      latestVersion: desktopUpdateState?.latestVersion || '',
      releaseUrl: desktopUpdateState?.releaseUrl || RELEASES_PAGE_URL,
      checkedAt: new Date().toISOString(),
      message: `自动更新失败：${message}`,
    });
  });

  electronAutoUpdaterConfigured = true;
  return updater;
}

async function performElectronUpdaterCheck({ manual = false } = {}) {
  const updater = configureElectronAutoUpdater();
  if (!updater) {
    throw new Error('当前平台不支持自动安装更新。');
  }
  if (electronUpdateCheckInFlight) {
    return desktopUpdateState;
  }

  electronUpdateCheckInFlight = true;
  setDesktopUpdateState({
    status: UPDATE_STATUS.CHECKING,
    updateMode: UPDATE_MODE.AUTO,
    currentVersion: resolveDesktopVersion(),
    message: manual ? '正在检查桌面端更新...' : '正在后台检查桌面端更新...',
  });

  try {
    await updater.checkForUpdates();
    return desktopUpdateState;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logLine(`[update] auto updater check failed: ${message}`);
    const nextState = setDesktopUpdateState({
      status: manual ? UPDATE_STATUS.ERROR : UPDATE_STATUS.IDLE,
      updateMode: UPDATE_MODE.AUTO,
      currentVersion: resolveDesktopVersion(),
      checkedAt: new Date().toISOString(),
      message: manual ? `检查更新失败：${message}` : '',
    });
    return nextState;
  } finally {
    electronUpdateCheckInFlight = false;
  }
}

async function performDesktopUpdateCheck({ manual = false, notify = false } = {}) {
  if (canUseElectronAutoUpdater()) {
    return performElectronUpdaterCheck({ manual, notify });
  }

  const currentVersion = resolveDesktopVersion();
  setDesktopUpdateState({
    status: UPDATE_STATUS.CHECKING,
    currentVersion,
    message: manual ? '正在检查桌面端更新...' : '正在后台检查桌面端更新...',
  });

  try {
    const nextState = await checkForDesktopUpdates({ currentVersion });
    const resolvedState = setDesktopUpdateState(nextState);
    logLine(
      `[update] status=${resolvedState.status} current=${resolvedState.currentVersion || 'unknown'} latest=${resolvedState.latestVersion || 'unknown'}`
    );
    if (notify) {
      await maybePromptDesktopUpdate(resolvedState);
    }
    return resolvedState;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logLine(`[update] check failed: ${message}`);

    if (manual) {
      return setDesktopUpdateState({
        status: UPDATE_STATUS.ERROR,
        currentVersion,
        checkedAt: new Date().toISOString(),
        message: `检查更新失败：${message}`,
      });
    }

    return setDesktopUpdateState({
      status: UPDATE_STATUS.IDLE,
      currentVersion,
      checkedAt: new Date().toISOString(),
      message: '',
    });
  }
}

ipcMain.handle('desktop:get-update-state', () => desktopUpdateState);
ipcMain.handle('desktop:check-for-updates', () => performDesktopUpdateCheck({ manual: true }));
ipcMain.handle('desktop:install-downloaded-update', () => installDownloadedUpdate());
ipcMain.handle('desktop:open-release-page', async (_event, releaseUrl) => {
  await shell.openExternal(sanitizeReleaseUrl(releaseUrl));
  return true;
});
ipcMain.handle('desktop:render-share-image', async (event, recordId) => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
    throw new Error('Share image request did not originate from the desktop window');
  }
  try {
    return await renderDesktopShareImage(recordId, { backendOrigin: desktopBackendOrigin });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logLine(`[share-image] desktop render failed for record=${recordId}: ${message}`);
    throw error;
  }
});

async function createWindow() {
  desktopBackendOrigin = '';
  const restoreResult = isWindowsNsisInstalledApp() ? restorePackagedRuntimeStateFromBackup() : null;
  const macMigrationResult = migrateMacPackagedRuntimeState();
  initLogging();
  if (macMigrationResult.migrated.length) {
    logLine(`[migration] migrated macOS runtime files from ${macMigrationResult.sourceDir} to ${macMigrationResult.targetDir}: ${macMigrationResult.migrated.join(', ')}`);
  }
  if (macMigrationResult.skipped.length) {
    logLine(`[migration] skipped existing macOS runtime files: ${macMigrationResult.skipped.join(', ')}`);
  }
  if (macMigrationResult.failed.length) {
    logLine(`[migration] failed to migrate macOS runtime files: ${macMigrationResult.failed.join(', ')}`);
  }
  const restoreFailed = Boolean(restoreResult && restoreResult.failed.length);
  const restoreIssueDetails = restoreResult
    ? restoreResult.failed.join('；')
    : '';
  const restoreErrorMessage = restoreFailed
    ? `上次更新安装未完成或恢复运行时文件失败，已保留备份目录 ${restoreResult.backupRoot}，请确认后手动恢复并重启应用。明细：${restoreIssueDetails}`
    : '';
  setDesktopUpdateState({
    status: restoreFailed ? UPDATE_STATUS.ERROR : UPDATE_STATUS.IDLE,
    currentVersion: resolveDesktopVersion(),
    updateMode: restoreFailed ? UPDATE_MODE.MANUAL : UPDATE_MODE.AUTO,
    message: restoreErrorMessage,
  });
  const startupStartedAt = Date.now();
  const logStartup = (message) => {
    logLine(`[startup +${Date.now() - startupStartedAt}ms] ${message}`);
  };

  logStartup('createWindow started');

  mainWindow = new BrowserWindow({
    title: 'StockMaster',
    width: 1200,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    autoHideMenuBar: true,
    backgroundColor: resolveWindowBackgroundColor(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      additionalArguments: [`--dsa-desktop-version=${app.getVersion()}`],
    },
  });
  mainWindow.removeMenu?.();
  logStartup('BrowserWindow created');

  const loadingPath = path.join(__dirname, 'renderer', 'loading.html');
  const loadingPageStartedAt = Date.now();
  await mainWindow.loadFile(loadingPath);
  logStartup(`Loading page rendered in ${Date.now() - loadingPageStartedAt}ms`);

  const applyThemeBackground = () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }
    mainWindow.setBackgroundColor(resolveWindowBackgroundColor());
  };
  nativeTheme.on('updated', applyThemeBackground);
  mainWindow.once('closed', () => {
    nativeTheme.removeListener('updated', applyThemeBackground);
  });

  const webViewStartedAt = Date.now();
  mainWindow.webContents.on('did-start-loading', () => {
    logStartup('WebContents did-start-loading');
  });
  mainWindow.webContents.on('dom-ready', () => {
    logStartup(`WebContents dom-ready (+${Date.now() - webViewStartedAt}ms after events attached)`);
  });
  mainWindow.webContents.on('did-finish-load', () => {
    logStartup(`WebContents did-finish-load (+${Date.now() - webViewStartedAt}ms after events attached)`);
  });
  mainWindow.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      logStartup(
        `WebContents did-fail-load code=${errorCode} mainFrame=${isMainFrame} url=${validatedURL} reason=${errorDescription}`
      );
    }
  );

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  const appDir = resolveAppDir();
  const envPath = path.join(appDir, '.env');
  ensureEnvFile(envPath);
  logStartup(`Env file ready: ${envPath}`);

  const backendBindHost = resolveBackendBindHost({ envFile: envPath });
  const backendConnectHost = resolveDesktopConnectHost(backendBindHost);
  logStartup(`Backend bind host=${backendBindHost}; desktop connect host=${backendConnectHost}`);

  const portFindStartedAt = Date.now();
  const port = await findAvailablePort(8000, 8100, backendBindHost);
  logStartup(`Using port ${port} (selected in ${Date.now() - portFindStartedAt}ms)`);
  desktopBackendOrigin = new URL(buildBackendUrl(backendConnectHost, port)).origin;
  logStartup(`App directory=${appDir}`);

  const dbPath = path.join(appDir, 'data', 'stock_analysis.db');
  const logDir = path.join(appDir, 'logs');
  const activeRuntime = await resolveActiveAlgorithmRuntime();
  if (activeRuntime?.path && process.env.STOCKMASTER_SYNC_DEV_UI === '1') {
    try {
      if (syncDevelopmentWebAssets({ runtimeRoot: activeRuntime.path })) {
        logStartup(`Synced local Web UI into active algorithm runtime=${activeRuntime.path}`);
      }
      const replayed = await replayDevelopmentBackendAdapters({ runtimeRoot: activeRuntime.path });
      if (replayed.applied) {
        logStartup(
          `Synced StockMaster backend overlays into active algorithm runtime=${activeRuntime.path}; `
          + `strategy=${replayed.strategy}; conflicts=${replayed.summary?.conflictPaths?.length || 0}`,
        );
      }
    } catch (error) {
      logStartup(`Local StockMaster overlay sync failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  activeBackendSourceRoot = activeRuntime?.path || '';
  backendRuntimeContext = {
    port,
    envFile: envPath,
    dbPath,
    logDir,
    host: backendBindHost,
    connectHost: backendConnectHost,
    algorithmCommit: activeRuntime?.commit || resolveStockMasterBaselineCommit(),
    algorithmAppliedCommit: activeRuntime?.commit || '',
    algorithmAppliedAt: activeRuntime?.activatedAt || '',
    algorithmMergePolicy: activeRuntime?.mergePolicy || '',
    algorithmLocalBaselineCommit: activeRuntime?.localBaselineCommit || '',
    algorithmLocalMergedPaths: activeRuntime?.localMergedPaths || [],
    algorithmLocalConflictPaths: activeRuntime?.localConflictPaths || [],
  };

  try {
    const launchInfo = startBackend({
      port,
      envFile: envPath,
      dbPath,
      logDir,
      host: backendBindHost,
      sourceRoot: activeBackendSourceRoot,
    });
    if (!app.isPackaged) {
      activeBackendSourceRoot = launchInfo.cwd;
      backendRuntimeContext.sourceRoot = launchInfo.cwd;
    }
    logStartup(`Backend launch mode=${launchInfo.mode}`);
    logStartup(`Backend launch command=${launchInfo.command}`);
    logStartup(`Backend launch cwd=${launchInfo.cwd}`);
    logStartup('Waiting for backend health check');
  } catch (error) {
    logStartup(`Backend launch failed: ${String(error)}`);
    const errorUrl = `file://${loadingPath}?error=${encodeURIComponent(String(error))}`;
    await mainWindow.loadURL(errorUrl);
    return;
  }

  const healthUrl = buildBackendUrl(backendConnectHost, port, '/api/health');
  let lastHealthProgressLogAt = 0;
  const healthProgressLogIntervalMs = 2000;

  const onHealthProgress = (event) => {
    if (!event || event.type === 'probe_start') {
      return;
    }

    if (event.type === 'ready') {
      logStartup(`Health ready in ${event.elapsedMs}ms (attempts=${event.attempts})`);
      return;
    }

    if (event.type === 'aborted' || event.type === 'total_timeout' || event.type === 'final_error') {
      const details = event.reason || event.message || '';
      logStartup(`Health ${event.type} after ${event.elapsedMs}ms (attempts=${event.attempts}) ${details}`.trim());
      return;
    }

    const now = Date.now();
    if (now - lastHealthProgressLogAt < healthProgressLogIntervalMs) {
      return;
    }

    lastHealthProgressLogAt = now;
    let detail = '';
    if (event.type === 'probe_status') {
      detail = `status=${event.statusCode}`;
    } else if (event.type === 'probe_timeout') {
      detail = `probeTimeout=${event.requestTimeoutMs}ms`;
    } else if (event.type === 'probe_error') {
      detail = `error=${event.errorCode}:${event.errorMessage}`;
    }

    logStartup(
      `Waiting for backend health... elapsed=${event.elapsedMs}ms attempts=${event.attempts}${detail ? ` ${detail}` : ''}`
    );
  };

  try {
    const healthInfo = await waitForHealth(
      healthUrl,
      60000,
      250,
      1500,
      () => {
        if (backendStartError) {
          return `backend start error: ${backendStartError.message}`;
        }
        if (!backendProcess) {
          return 'backend process is unavailable';
        }
        if (backendProcess.exitCode !== null) {
          return `backend exited with code ${backendProcess.exitCode}`;
        }
        if (backendProcess.signalCode) {
          return `backend exited by signal ${backendProcess.signalCode}`;
        }
        return null;
      },
      onHealthProgress
    );
    logStartup(`Backend ready in ${healthInfo.elapsedMs}ms (${healthInfo.attempts} probes)`);
    const mainPageStartedAt = Date.now();
    const mainPageUrl = buildMainPageUrl(port, Date.now(), backendConnectHost);
    await mainWindow.loadURL(mainPageUrl);
    logStartup(`Main page loadURL resolved in ${Date.now() - mainPageStartedAt}ms url=${mainPageUrl}`);
    logStartup(`Main UI loaded in ${Date.now() - startupStartedAt}ms`);
    if (!restoreFailed) {
      // Startup only checks the pinned upstream algorithm baseline. Desktop
      // release checks remain an explicit Settings-page action so a local
      // StockMaster run never prompts for a full-stack GitHub upgrade.
      startAlgorithmUpdateMonitor();
    }
  } catch (error) {
    logStartup(`Startup failed while waiting for health: ${String(error)}`);
    const errorUrl = `file://${loadingPath}?error=${encodeURIComponent(String(error))}`;
    await mainWindow.loadURL(errorUrl);
  }
}

app.whenReady().then(createWindow);

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on('window-all-closed', () => {
  void stopBackend();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  stopAlgorithmUpdateMonitor();
  void stopBackend();
});
ipcMain.handle('algorithm-update:get-state', () => algorithmUpdateMonitor?.getState() || { status: 'disabled' });
ipcMain.handle('algorithm-update:check-now', async () => {
  if (!algorithmUpdateMonitor) return { status: 'disabled' };
  await algorithmUpdateMonitor.checkNow();
  return algorithmUpdateMonitor.getState();
});
ipcMain.handle('algorithm-update:sync', async (event) => {
  if (!mainWindow || mainWindow.isDestroyed() || event?.sender !== mainWindow.webContents) {
    throw new Error('算法同步请求来源无效。');
  }
  return syncAlgorithmUpdate();
});

module.exports = {
  DEFAULT_REQUEST_TIMEOUT_MS,
  GITHUB_OWNER,
  GITHUB_REPO,
  LATEST_RELEASE_API_URL,
  RELEASES_PAGE_URL,
  DESKTOP_UPDATE_RUNTIME_RELATIVE_FILES,
  STOCKMASTER_BACKEND_ADAPTER_FILES,
  UPDATE_MODE,
  UPDATE_STATUS,
  buildUpdateState,
  backupPackagedRuntimeState,
  buildBackendArgs,
  checkForDesktopUpdates,
  compareVersions,
  evaluateReleaseUpdate,
  buildBackendUrl,
  buildBackendEnvironment,
  extendMacDesktopBackendPath,
  extractReleaseMetadata,
  fetchLatestReleaseJson,
  findAvailablePort,
  buildMainPageUrl,
  buildDesktopShareImageUrl,
  migrateMacPackagedRuntimeState,
  normalizeVersionString,
  parseSemver,
  readEnvFileValue,
  resolveAppDir,
  resolveBackendBindHost,
  resolveDesktopConnectHost,
  renderDesktopShareImage,
  restorePackagedRuntimeStateFromBackup,
  sanitizeReleaseUrl,
  syncDevelopmentBackendAdapters,
  replayDevelopmentBackendAdapters,
  syncDevelopmentWebAssets,
  startBackend,
  stopBackend,
  __getBackendProcessForTest() {
    return backendProcess;
  },
  __setBackendProcessForTest,
  __setMainWindowForTest(mainWindowRef = null) {
    mainWindow = mainWindowRef;
  },
  waitForBackendExit,
};
