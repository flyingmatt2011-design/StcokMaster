import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import StockMasterHoldingsPage from '../StockMasterHoldingsPage';

const { getSnapshot, getQuote } = vi.hoisted(() => ({ getSnapshot: vi.fn(), getQuote: vi.fn() }));

vi.mock('../../api/portfolio', () => ({ portfolioApi: { getSnapshot } }));
vi.mock('../../api/stocks', () => ({ stocksApi: { getQuote } }));

describe('StockMasterHoldingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSnapshot.mockResolvedValue({
      asOf: '2026-08-11T15:00:00+08:00',
      currency: 'CNY',
      totalMarketValue: 1200,
      totalEquity: 1200,
      totalCash: 0,
      totalPnl: 200,
      unrealizedPnl: 200,
      accounts: [{
        accountId: 1,
        accountName: 'StockMaster manual',
        positions: [{ symbol: '600519', quantity: 100, avgCost: 10, lastPrice: 12, marketValueBase: 1200, unrealizedPnlBase: 200 }],
      }],
    });
    getQuote.mockResolvedValue({ stockCode: '600519', prevClose: 11.5, currentPrice: 12 });
  });

  it('shows total value, total P/L, daily P/L, and a holding card', async () => {
    render(<StockMasterHoldingsPage />);
    expect(await screen.findByText('\u6301\u4ed3')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('600519')).toBeInTheDocument());
    expect(screen.getAllByText('¥1,200.00').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('¥200.00').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('\u65e5\u76c8\u4e8f').length).toBeGreaterThanOrEqual(2);
  });
});
