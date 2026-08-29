import { beforeEach, describe, expect, it, vi } from 'vitest';
import { analysisApi } from '../analysis';

const post = vi.hoisted(() => vi.fn());
const get = vi.hoisted(() => vi.fn());

vi.mock('../index', () => ({
  default: {
    get,
    post,
  },
}));

describe('analysisApi.triggerMarketReview', () => {
  beforeEach(() => {
    get.mockReset();
    post.mockReset();
    post.mockResolvedValue({
      status: 202,
      data: {
        status: 'accepted',
        message: 'accepted',
        send_notification: true,
        region: 'cn,us',
        task_id: 'market-task-1',
      },
    });
  });

  it('serializes selected markets to a comma-separated request string', async () => {
    const result = await analysisApi.triggerMarketReview({
      sendNotification: false,
      regions: ['cn', 'us'],
    });

    expect(post).toHaveBeenCalledWith(
      '/api/v1/analysis/market-review',
      {
        send_notification: false,
        report_language: undefined,
        region: 'cn,us',
      },
      expect.any(Object),
    );
    expect(result.region).toBe('cn,us');
  });

  it('omits region when the caller inherits the server default', async () => {
    await analysisApi.triggerMarketReview({ sendNotification: true });

    expect(post).toHaveBeenCalledWith(
      '/api/v1/analysis/market-review',
      {
        send_notification: true,
        report_language: undefined,
      },
      expect.any(Object),
    );
  });
});

describe('analysisApi.getMarketSnapshot', () => {
  beforeEach(() => {
    get.mockReset();
    get.mockResolvedValue({
      data: {
        payload: { indices: [{ code: '000001', name: '上证指数' }] },
        refreshed_at: '2026-08-26T09:35:00+08:00',
        mode: 'market_data_only',
        uses_llm: false,
      },
    });
  });

  it('uses the data-only dashboard endpoint and maps response fields', async () => {
    const result = await analysisApi.getMarketSnapshot('cn');

    expect(get).toHaveBeenCalledWith('/api/v1/analysis/market-snapshot', {
      params: { region: 'cn' },
    });
    expect(result).toMatchObject({
      refreshedAt: '2026-08-26T09:35:00+08:00',
      mode: 'market_data_only',
      usesLlm: false,
    });
  });
});
