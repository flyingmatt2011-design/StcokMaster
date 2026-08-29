import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import StockMasterSettingsPage from '../StockMasterSettingsPage';

vi.mock('../../hooks/useSystemConfig', () => ({
  useSystemConfig: () => ({
    configVersion: 'v1',
    maskToken: '******',
    itemsByCategory: {
      ai_model: [
        { key: 'LLM_CHANNELS', value: 'deepseek', rawValueExists: true },
        { key: 'LLM_DEEPSEEK_PROTOCOL', value: 'deepseek', rawValueExists: true },
        { key: 'LLM_DEEPSEEK_API_SURFACE', value: 'chat_completions', rawValueExists: true },
        { key: 'LLM_DEEPSEEK_BASE_URL', value: 'https://api.deepseek.com', rawValueExists: true },
        { key: 'LLM_DEEPSEEK_API_KEY', value: '', rawValueExists: false },
        { key: 'LLM_DEEPSEEK_MODELS', value: 'deepseek-chat', rawValueExists: true },
      ],
      data_source: [
        { key: 'BOCHA_API_KEYS', value: '', rawValueExists: false },
        { key: 'TAVILY_API_KEYS', value: '', rawValueExists: false },
        { key: 'BRAVE_API_KEYS', value: '', rawValueExists: false },
        { key: 'SERPAPI_API_KEYS', value: '', rawValueExists: false },
        { key: 'SEARXNG_BASE_URLS', value: '', rawValueExists: false },
        { key: 'SEARXNG_PUBLIC_INSTANCES_ENABLED', value: 'false', rawValueExists: true },
      ],
    },
    llmModelProviders: ['deepseek'],
    isLoading: false,
    isSaving: false,
    load: vi.fn().mockResolvedValue(true),
    refreshAfterExternalSave: vi.fn().mockResolvedValue(undefined),
  }),
}));

describe('StockMasterSettingsPage', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {
      ...window,
      dsaDesktop: {
        version: '3.21.0',
        getAlgorithmUpdateState: vi.fn().mockResolvedValue({ status: 'idle', currentCommit: 'base' }),
        checkAlgorithmUpdateNow: vi.fn().mockResolvedValue({ status: 'idle', currentCommit: 'base' }),
      },
    });
  });

  it('shows the compact StockMaster settings and algorithm update check', async () => {
    render(<StockMasterSettingsPage />);
    expect(await screen.findByText('\u8bbe\u7f6e')).toBeInTheDocument();
    expect(screen.getByText('\u5206\u6790\u7b97\u6cd5\u66f4\u65b0')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '\u7acb\u5373\u68c0\u67e5' })).toBeInTheDocument();
    expect(screen.getByTestId('stockmaster-provider-settings')).toBeInTheDocument();
    expect(screen.getByText('AI 模型 API')).toBeInTheDocument();
    expect(screen.getByTestId('stockmaster-news-search-settings')).toBeInTheDocument();
    expect(screen.getByText('新闻搜索 API')).toBeInTheDocument();
    expect(screen.getByTestId('stockmaster-advanced-settings')).toHaveClass('hidden');
    fireEvent.click(screen.getByRole('button', { name: '高级设置' }));
    expect(screen.getByTestId('stockmaster-advanced-settings')).not.toHaveClass('hidden');
  });

  it('distinguishes a checked baseline from a pending algorithm update', async () => {
    const syncAlgorithmUpdate = vi.fn().mockResolvedValue({
      status: 'idle',
      currentCommit: 'candidatecommit',
      algorithmUpdateAvailable: false,
      syncStatus: 'succeeded',
      syncMessage: '后端算法已同步并通过健康检查；三方合并 1 个文件，StockMaster 优先解决 1 个冲突',
      mergePolicy: 'three-way-local-wins',
      localBaselineCommit: 'baselinecommit',
      localMergedPaths: ['src/analyzer.py'],
      localConflictPaths: ['src/analyzer.py'],
    });
    const state = {
      status: 'idle',
      currentCommit: 'basecommit',
      lastCheckedAt: '2026-08-19T05:00:00.000Z',
      algorithmUpdateAvailable: true,
      candidateCommit: 'candidatecommit',
      candidatePaths: ['src/analyzer.py'],
    };
    vi.stubGlobal('window', {
      ...window,
      dsaDesktop: {
        version: '3.21.0',
        getAlgorithmUpdateState: vi.fn().mockResolvedValue(state),
        checkAlgorithmUpdateNow: vi.fn().mockResolvedValue(state),
        syncAlgorithmUpdate,
      },
    });

    render(<StockMasterSettingsPage />);

    fireEvent.click(screen.getByRole('button', { name: '高级设置' }));
    expect(await screen.findByText('发现待确认算法更新')).toBeInTheDocument();
    expect(screen.getByText(/当前运行版本尚未切换/)).toBeInTheDocument();
    expect(screen.getByText('当前运行基线')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByTestId('algorithm-update-sync'));
    });
    expect(syncAlgorithmUpdate).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/StockMaster 优先解决 1 个冲突/)).toBeInTheDocument();
    expect(screen.getByTestId('algorithm-merge-audit')).toHaveTextContent('本地优先冲突 1 个');
  });
});
