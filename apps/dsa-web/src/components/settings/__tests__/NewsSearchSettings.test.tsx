import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NewsSearchSettings } from '../NewsSearchSettings';

const validate = vi.hoisted(() => vi.fn());
const update = vi.hoisted(() => vi.fn());
const testSearchProvider = vi.hoisted(() => vi.fn());

vi.mock('../../../api/systemConfig', () => ({
  systemConfigApi: { validate, update, testSearchProvider },
}));

const items = [
  { key: 'BOCHA_API_KEYS', value: '', rawValueExists: false, isMasked: false },
  { key: 'TAVILY_API_KEYS', value: '', rawValueExists: false, isMasked: false },
  { key: 'BRAVE_API_KEYS', value: '', rawValueExists: false, isMasked: false },
  { key: 'SERPAPI_API_KEYS', value: '', rawValueExists: false, isMasked: false },
  { key: 'SEARXNG_BASE_URLS', value: '', rawValueExists: false, isMasked: false },
  { key: 'SEARXNG_PUBLIC_INSTANCES_ENABLED', value: 'false', rawValueExists: true, isMasked: false },
];

describe('NewsSearchSettings', () => {
  beforeEach(() => {
    validate.mockReset();
    update.mockReset();
    testSearchProvider.mockReset();
    validate.mockResolvedValue({ valid: true, issues: [] });
    update.mockResolvedValue({ success: true, warnings: [], updatedKeys: ['BOCHA_API_KEYS'] });
    testSearchProvider.mockResolvedValue({
      success: true,
      provider: 'bocha',
      message: '连接成功，返回 2 条结果',
      resultCount: 2,
      retryable: false,
      latencyMs: 88,
    });
  });

  it('tests an unsaved provider key and saves the search-only draft', async () => {
    const onSaved = vi.fn().mockResolvedValue(undefined);
    render(
      <NewsSearchSettings
        items={items}
        configVersion="v1"
        maskToken="******"
        onSaved={onSaved}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText('填写 Bocha API Key'), { target: { value: 'bocha-draft' } });
    const bochaSection = screen.getByText('Bocha 博查搜索').closest('div.border-t');
    expect(bochaSection).not.toBeNull();
    fireEvent.click(bochaSection!.querySelector('button')!);

    await waitFor(() => expect(testSearchProvider).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'bocha',
      items: expect.arrayContaining([{ key: 'BOCHA_API_KEYS', value: 'bocha-draft' }]),
    })));
    expect(await screen.findByText(/连接成功，返回 2 条结果/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '保存新闻搜索配置' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith(expect.objectContaining({
      configVersion: 'v1',
      reloadNow: true,
      items: expect.arrayContaining([
        { key: 'BOCHA_API_KEYS', value: 'bocha-draft' },
        { key: 'SEARXNG_PUBLIC_INSTANCES_ENABLED', value: 'false' },
      ]),
    })));
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/新闻搜索配置已保存/)).toBeInTheDocument();
  });
});
