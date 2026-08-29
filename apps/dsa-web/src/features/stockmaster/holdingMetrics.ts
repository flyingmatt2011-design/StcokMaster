export type HoldingMetricsInput = {
  quantity: number;
  averageCost: number;
  currentPrice?: number;
  previousClose?: number;
};

export type HoldingMetrics = {
  marketValue?: number;
  totalPnl?: number;
  totalReturnPct?: number;
  dailyPnl?: number;
  dailyReturnPct?: number;
  quality: 'ready' | 'stale' | 'missing-price' | 'missing-prev-close';
};

export function calculateHoldingMetrics(input: HoldingMetricsInput): HoldingMetrics {
  const { quantity, averageCost, currentPrice, previousClose } = input;
  if (!Number.isFinite(quantity) || !Number.isFinite(averageCost) || quantity <= 0 || averageCost <= 0) {
    return { quality: 'missing-price' };
  }
  if (!Number.isFinite(currentPrice) || currentPrice == null || currentPrice <= 0) {
    return { quality: 'missing-price' };
  }

  const marketValue = quantity * currentPrice;
  const totalPnl = quantity * (currentPrice - averageCost);
  const totalReturnPct = (totalPnl / (quantity * averageCost)) * 100;
  if (!Number.isFinite(previousClose) || previousClose == null || previousClose <= 0) {
    return { marketValue, totalPnl, totalReturnPct, dailyPnl: undefined, dailyReturnPct: undefined, quality: 'missing-prev-close' };
  }

  const dailyPnl = quantity * (currentPrice - previousClose);
  const dailyReturnPct = ((currentPrice - previousClose) / previousClose) * 100;
  return { marketValue, totalPnl, totalReturnPct, dailyPnl, dailyReturnPct, quality: 'ready' };
}
