import { useCallback, useEffect, useState } from 'react';
import type React from 'react';
import { CheckCircle2, Download, ExternalLink, RefreshCw, ShieldCheck } from 'lucide-react';
import { LLMChannelEditor } from '../components/settings/LLMChannelEditor';
import { NewsSearchSettings } from '../components/settings/NewsSearchSettings';
import { ThemeToggle } from '../components/theme/ThemeToggle';
import { useUiLanguage } from '../contexts/UiLanguageContext';
import { useSystemConfig } from '../hooks/useSystemConfig';
import { WEB_BUILD_INFO } from '../utils/constants';

type AlgorithmUpdateState = {
  status?: string;
  currentCommit?: string;
  lastSeenCommit?: string;
  lastCheckedAt?: string;
  nextCheckAt?: string;
  consecutiveFailures?: number;
  error?: string;
  algorithmUpdateAvailable?: boolean;
  candidateCommit?: string;
  candidatePaths?: string[];
  candidateDependencyPaths?: string[];
  candidateRemovedPaths?: string[];
  syncStatus?: string;
  syncMessage?: string;
  appliedCommit?: string;
  lastAppliedAt?: string;
  mergePolicy?: string;
  localBaselineCommit?: string;
  localMergedPaths?: string[];
  localConflictPaths?: string[];
  localProtectionPathCount?: number;
};

type DesktopApi = {
  version?: unknown;
  getAlgorithmUpdateState?: () => Promise<AlgorithmUpdateState>;
  checkAlgorithmUpdateNow?: () => Promise<AlgorithmUpdateState>;
  syncAlgorithmUpdate?: () => Promise<AlgorithmUpdateState>;
  onAlgorithmUpdateStateChange?: (listener: (state: AlgorithmUpdateState) => void) => (() => void) | void;
};

function desktopApi(): DesktopApi | undefined {
  return typeof window === 'undefined' ? undefined : (window as Window & { dsaDesktop?: DesktopApi }).dsaDesktop;
}

const StockMasterSettingsPage: React.FC = () => {
  const { language, setLanguage } = useUiLanguage();
  const {
    configVersion,
    maskToken,
    itemsByCategory,
    llmModelProviders,
    isLoading: isConfigLoading,
    isSaving: isConfigSaving,
    load: loadSystemConfig,
    refreshAfterExternalSave,
  } = useSystemConfig();
  const [updateState, setUpdateState] = useState<AlgorithmUpdateState | null>(null);
  const [checking, setChecking] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [settingsLevel, setSettingsLevel] = useState<'basic' | 'advanced'>('basic');

  const loadUpdateState = useCallback(async () => {
    const api = desktopApi();
    if (!api?.getAlgorithmUpdateState) return;
    setUpdateState(await api.getAlgorithmUpdateState());
  }, []);

  useEffect(() => {
    document.title = 'StockMaster · 设置';
    let active = true;
    void desktopApi()?.getAlgorithmUpdateState?.().then((state) => {
      if (active) setUpdateState(state);
    });
    const unsubscribe = desktopApi()?.onAlgorithmUpdateStateChange?.((state) => setUpdateState(state));
    return () => {
      active = false;
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, []);

  useEffect(() => {
    void loadSystemConfig();
  }, [loadSystemConfig]);

  const checkNow = async () => {
    const api = desktopApi();
    if (!api?.checkAlgorithmUpdateNow) return;
    setChecking(true);
    try { setUpdateState(await api.checkAlgorithmUpdateNow()); } finally { setChecking(false); }
  };

  const syncNow = async () => {
    const api = desktopApi();
    if (!api?.syncAlgorithmUpdate) return;
    setSyncing(true);
    try {
      setUpdateState(await api.syncAlgorithmUpdate());
    } catch {
      await loadUpdateState();
    } finally {
      setSyncing(false);
    }
  };

  const statusLabel = updateState?.status === 'error'
    ? '\u68c0\u67e5\u5931\u8d25'
    : updateState?.status === 'checking'
      ? '\u6b63\u5728\u68c0\u67e5'
      : updateState?.algorithmUpdateAvailable
        ? '\u53d1\u73b0\u5f85\u786e\u8ba4\u7b97\u6cd5\u66f4\u65b0'
        : updateState?.lastCheckedAt
          ? '\u5df2\u68c0\u67e5\uff0c\u5f53\u524d\u65e0\u7b97\u6cd5\u66f4\u65b0'
          : updateState?.status === 'disabled'
            ? '\u672a\u542f\u7528\u68c0\u67e5'
            : '\u7b49\u5f85\u9996\u6b21\u68c0\u67e5';
  const updateStatusClass = updateState?.status === 'error'
    ? 'text-warning'
    : updateState?.algorithmUpdateAvailable
      ? 'text-primary'
      : 'text-success';
  const providerItems = itemsByCategory.ai_model ?? [];
  const dataSourceItems = itemsByCategory.data_source ?? [];
  const syncInProgress = syncing || ['downloading', 'validating', 'activating'].includes(updateState?.syncStatus || '');
  const syncLabel = updateState?.syncStatus === 'downloading'
    ? '正在下载'
    : updateState?.syncStatus === 'validating'
      ? '正在校验'
      : updateState?.syncStatus === 'activating'
        ? '正在切换'
        : '同步更新';

  return (
    <div className="sm-reference-page mx-auto flex h-full w-full max-w-5xl flex-col gap-5 overflow-y-auto p-4 md:p-6">
      <header>
        <p className="text-xs uppercase tracking-[0.2em] text-primary">StockMaster</p>
        <h1 className="mt-1 text-2xl font-semibold">{'\u8bbe\u7f6e'}</h1>
        <p className="mt-1 text-sm text-muted-text">{'\u4fdd\u7559\u4e2a\u4eba\u5206\u6790\u6240\u9700\u7684\u6700\u5c0f\u8bbe\u7f6e'}</p>
        <div className="mt-4 inline-flex rounded-xl border border-border/70 bg-card p-1" aria-label="设置层级">
          <button
            type="button"
            className={`rounded-lg px-3 py-1.5 text-sm ${settingsLevel === 'basic' ? 'bg-primary/15 font-medium text-primary' : 'text-muted-text'}`}
            onClick={() => setSettingsLevel('basic')}
          >
            基础设置
          </button>
          <button
            type="button"
            className={`rounded-lg px-3 py-1.5 text-sm ${settingsLevel === 'advanced' ? 'bg-primary/15 font-medium text-primary' : 'text-muted-text'}`}
            onClick={() => setSettingsLevel('advanced')}
          >
            高级设置
          </button>
        </div>
      </header>

      <section className="grid gap-4 md:grid-cols-2">
        <article className="rounded-2xl border border-border/70 bg-card p-5 shadow-sm">
          <div className="flex items-start justify-between gap-3"><div><h2 className="font-semibold">{'\u754c\u9762\u504f\u597d'}</h2><p className="mt-1 text-sm text-muted-text">{'\u5207\u6362\u8bed\u8a00\u548c\u6df1\u8272\u6a21\u5f0f'}</p></div><ThemeToggle /></div>
          <div className="mt-4 flex gap-2"><button type="button" className={`rounded-xl px-3 py-2 text-sm ${language === 'zh' ? 'bg-primary/15 text-primary' : 'text-muted-text'}`} onClick={() => setLanguage('zh')}>{'\u4e2d\u6587'}</button><button type="button" className={`rounded-xl px-3 py-2 text-sm ${language === 'en' ? 'bg-primary/15 text-primary' : 'text-muted-text'}`} onClick={() => setLanguage('en')}>English</button></div>
        </article>
        <article className="rounded-2xl border border-border/70 bg-card p-5 shadow-sm"><div className="flex items-center gap-2"><ShieldCheck className="h-5 w-5 text-primary" /><h2 className="font-semibold">{'\u5206\u6790\u80fd\u529b'}</h2></div><p className="mt-3 text-sm leading-6 text-muted-text">{'\u5ef6\u7528\u539f\u9879\u76ee\u7684\u884c\u60c5\u3001\u6280\u672f\u6307\u6807\u3001\u65b0\u95fb\u548c AI \u8bc4\u5206\u7b56\u7565\uff0cStockMaster \u53ea\u505a\u5c55\u793a\u548c\u64cd\u4f5c\u5c42\u7b80\u5316\u3002'}</p></article>
      </section>

      <section data-testid="stockmaster-news-search-settings" className="rounded-2xl border border-border/70 bg-card p-5 shadow-sm">
        {isConfigLoading ? <p className="text-sm text-muted-text">正在读取新闻搜索配置…</p> : dataSourceItems.length > 0 ? (
          <NewsSearchSettings
            items={dataSourceItems}
            configVersion={configVersion}
            maskToken={maskToken}
            onSaved={async (updatedItems) => {
              await refreshAfterExternalSave(updatedItems.map((item) => item.key));
            }}
            disabled={isConfigSaving}
          />
        ) : <p className="text-sm text-muted-text">当前后端没有返回新闻搜索配置项，请先检查后端配置接口。</p>}
      </section>

      <section data-testid="stockmaster-provider-settings" className="rounded-2xl border border-border/70 bg-card p-5 shadow-sm">
        <div className="mb-4">
          <h2 className="font-semibold">AI 模型 API</h2>
          <p className="mt-1 text-sm leading-6 text-muted-text">复用原项目的 LLM 渠道配置，可设置服务商、API Surface、Base URL、API Key 和模型；不会修改股票分析策略。</p>
        </div>
        {isConfigLoading ? <p className="text-sm text-muted-text">正在读取 provider 配置…</p> : providerItems.length > 0 ? (
          <LLMChannelEditor
            items={providerItems}
            configVersion={configVersion}
            maskToken={maskToken}
            modelProviderPrefixes={llmModelProviders}
            onSaved={async (updatedItems) => {
              await refreshAfterExternalSave(updatedItems.map((item) => item.key));
            }}
            disabled={isConfigSaving}
          />
        ) : <p className="text-sm text-muted-text">当前后端没有返回 provider 配置项，请先检查后端配置接口。</p>}
      </section>

      <section className={`rounded-2xl border border-border/70 bg-card p-5 shadow-sm ${settingsLevel === 'advanced' ? '' : 'hidden'}`} data-testid="stockmaster-advanced-settings">
        <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="font-semibold">{'\u5206\u6790\u7b97\u6cd5\u66f4\u65b0'}</h2><p className="mt-1 text-sm text-muted-text">每分钟检查固定上游仓库，仅同步后端算法文件。兼容改动自动合入；发生冲突时以 StockMaster 本轮实现为准，不同步 UI。</p></div><button type="button" className="btn-secondary" onClick={() => void checkNow()} disabled={checking}><RefreshCw className={`h-4 w-4 ${checking ? 'animate-spin' : ''}`} />{'\u7acb\u5373\u68c0\u67e5'}</button></div>
        <div className="mt-4 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div><p className="text-xs text-muted-text">{'\u5f53\u524d\u8fd0\u884c\u72b6\u6001'}</p><p className={`mt-1 font-medium ${updateStatusClass}`}>{statusLabel}</p></div>
          <div><p className="text-xs text-muted-text">{'\u5f53\u524d\u8fd0\u884c\u57fa\u7ebf'}</p><p className="mt-1 font-mono text-xs">{updateState?.currentCommit?.slice(0, 8) || '\u672a\u63d0\u4f9b'}</p></div>
          <div><p className="text-xs text-muted-text">{'\u6700\u8fd1\u68c0\u67e5'}</p><p className="mt-1 text-xs">{updateState?.lastCheckedAt || '\u5c1a\u672a\u68c0\u67e5'}</p></div>
          <div><p className="text-xs text-muted-text">{'\u4e0b\u6b21\u68c0\u67e5'}</p><p className="mt-1 text-xs">{updateState?.nextCheckAt || '\u542f\u52a8\u540e\u81ea\u52a8\u5b89\u6392'}</p></div>
        </div>
        {updateState?.algorithmUpdateAvailable ? (
          <div className="mt-3 rounded-xl border border-primary/25 bg-primary/5 p-3 text-sm">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="font-medium text-primary">{'\u53d1\u73b0\u4e0a\u6e38\u540e\u7aef\u7b97\u6cd5\u66f4\u65b0'}</p>
                <p className="mt-1 text-xs text-muted-text">只同步允许范围内的后端文件，不同步原项目 UI。</p>
              </div>
              <button type="button" className="btn-primary whitespace-nowrap" onClick={() => void syncNow()} disabled={syncInProgress} data-testid="algorithm-update-sync">
                {syncInProgress ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                {syncLabel}
              </button>
            </div>
            <p className="mt-1 text-muted-text">{'\u5019\u9009\u63d0\u4ea4'} <span className="font-mono text-xs text-foreground">{updateState.candidateCommit?.slice(0, 8) || '\u672a\u63d0\u4f9b'}</span>{'\uff0c\u5f53\u524d\u8fd0\u884c\u7248\u672c\u5c1a\u672a\u5207\u6362\u3002'}</p>
            {updateState.candidatePaths?.length ? <p className="mt-1 text-xs text-muted-text">{'\u6d89\u53ca'} {updateState.candidatePaths.length} {'\u4e2a\u540e\u7aef\u6587\u4ef6'}：{updateState.candidatePaths.slice(0, 3).join('\u3001')}{updateState.candidatePaths.length > 3 ? '\u2026' : ''}</p> : null}
          </div>
        ) : updateState?.lastCheckedAt && updateState.status !== 'error' ? (
          <div className="mt-3 rounded-xl border border-success/20 bg-success/5 p-3 text-sm text-success">{'\u6700\u8fd1\u4e00\u6b21\u68c0\u67e5\u672a\u53d1\u73b0\u9700\u8981\u66f4\u65b0\u7684\u540e\u7aef\u5206\u6790\u7b97\u6cd5\uff0c\u5f53\u524d\u57fa\u7ebf\u5c31\u662f\u5f53\u524d\u8fd0\u884c\u7248\u672c\u3002'}</div>
        ) : null}
        {updateState?.error ? <p className="mt-3 rounded-xl bg-warning/10 p-3 text-sm text-warning">{updateState.error}</p> : null}
        {updateState?.syncMessage ? (
          <p className={`mt-3 rounded-xl p-3 text-sm ${updateState.syncStatus === 'failed' ? 'bg-danger/10 text-danger' : updateState.syncStatus === 'succeeded' ? 'bg-success/10 text-success' : 'bg-primary/5 text-primary'}`} role="status">
            {updateState.syncMessage}
          </p>
        ) : null}
        {updateState?.appliedCommit ? <p className="mt-3 text-xs text-muted-text">最近已同步：<span className="font-mono text-foreground">{updateState.appliedCommit.slice(0, 8)}</span>{updateState.lastAppliedAt ? `，${updateState.lastAppliedAt}` : ''}</p> : null}
        {updateState?.mergePolicy === 'three-way-local-wins' ? (
          <div className="mt-3 rounded-xl border border-border/70 bg-muted/30 p-3 text-xs text-muted-text" data-testid="algorithm-merge-audit">
            <p className="font-medium text-foreground">合并策略：上游兼容更新 + StockMaster 冲突优先</p>
            <p className="mt-1">已登记 {updateState.localProtectionPathCount || 0} 个 StockMaster 强需求文件；远端同路径发生冲突时保留本地完整文件。</p>
            <p className="mt-1">本地基线 {updateState.localBaselineCommit?.slice(0, 8) || '未记录'}；已三方合并 {updateState.localMergedPaths?.length || 0} 个文件；本地优先冲突 {updateState.localConflictPaths?.length || 0} 个。</p>
          </div>
        ) : null}
        <p className="mt-4 flex items-center gap-2 text-xs text-muted-text"><CheckCircle2 className="h-4 w-4 text-success" />检测到更新不代表已经应用。点击“同步更新”后，会先三方合并并校验候选后端，健康检查通过才会切换；失败会恢复原运行版本。</p>
      </section>

      <section className="rounded-2xl border border-border/70 bg-card p-5 text-sm shadow-sm"><h2 className="font-semibold">{'\u7248\u672c\u4fe1\u606f'}</h2><div className="mt-3 grid gap-2 text-muted-text sm:grid-cols-3"><span>Web: {WEB_BUILD_INFO.version}</span><span>Revision: {WEB_BUILD_INFO.revision}</span><span>Electron: {String(desktopApi()?.version || '\u5f00\u53d1\u6a21\u5f0f')}</span></div><a className="mt-4 inline-flex items-center gap-1 text-primary" href="https://github.com/ZhuLinsen/daily_stock_analysis" target="_blank" rel="noreferrer">{'\u67e5\u770b\u539f\u9879\u76ee'}<ExternalLink className="h-3.5 w-3.5" /></a></section>
    </div>
  );
};

export default StockMasterSettingsPage;
