import { useCallback, useEffect, useMemo, useState } from 'react';
import type React from 'react';
import { Plus, RefreshCw, Trash2 } from 'lucide-react';
import { portfolioApi } from '../api/portfolio';
import { stocksApi } from '../api/stocks';
import type { PortfolioAccountSnapshot, PortfolioPositionItem, PortfolioSnapshotResponse } from '../types/portfolio';
import { calculateHoldingMetrics } from '../features/stockmaster/holdingMetrics';

const text = {
  holdings: '\u6301\u4ed3',
  dailyPnl: '\u65e5\u76c8\u4e8f',
  totalPnl: '\u603b\u76c8\u4e8f',
  marketValue: '\u5e02\u503c',
};

const money = (value?: number) => typeof value === 'number' && Number.isFinite(value)
  ? `¥${value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  : '\u6682\u65e0\u6570\u636e';

type QuoteMap = Record<string, { previousClose?: number; currentPrice?: number }>;

const PositionCard: React.FC<{ position: PortfolioPositionItem; quote?: QuoteMap[string] }> = ({ position, quote }) => {
  const metrics = calculateHoldingMetrics({
    quantity: position.quantity,
    averageCost: position.avgCost,
    currentPrice: quote?.currentPrice ?? position.lastPrice,
    previousClose: quote?.previousClose,
  });
  const pnlClass = (value?: number) => value == null ? 'text-muted-text' : value >= 0 ? 'text-[var(--home-price-up)]' : 'text-[var(--home-price-down)]';
  return (
    <article className="rounded-2xl border border-border/70 bg-card p-4 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div><h3 className="font-semibold text-foreground">{position.symbol}</h3><p className="mt-1 text-xs text-muted-text">{text.holdings} {position.quantity} {'\u80a1'} · {'\u6210\u672c'} {money(position.avgCost)}</p></div>
        <div className="text-right"><p className="text-xs text-muted-text">{'\u5f53\u524d\u4ef7'}</p><p className="font-mono text-lg font-semibold">{money(quote?.currentPrice ?? position.lastPrice)}</p></div>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <div><p className="text-xs text-muted-text">{text.marketValue}</p><p className="mt-1 font-medium">{money(metrics.marketValue)}</p></div>
        <div><p className="text-xs text-muted-text">{text.totalPnl}</p><p className={`mt-1 font-medium ${pnlClass(metrics.totalPnl)}`}>{money(metrics.totalPnl)}</p></div>
        <div><p className="text-xs text-muted-text">{'\u6536\u76ca\u7387'}</p><p className={`mt-1 font-medium ${pnlClass(metrics.totalReturnPct)}`}>{metrics.totalReturnPct == null ? '\u6682\u65e0\u6570\u636e' : `${metrics.totalReturnPct.toFixed(2)}%`}</p></div>
        <div><p className="text-xs text-muted-text">{text.dailyPnl}</p><p className={`mt-1 font-medium ${pnlClass(metrics.dailyPnl)}`}>{money(metrics.dailyPnl)}</p></div>
      </div>
      {metrics.quality !== 'ready' ? <p className="mt-3 text-xs text-warning">{metrics.quality === 'missing-prev-close' ? '\u7f3a\u5c11\u6628\u6536\uff0c\u65e5\u76c8\u4e8f\u6682\u4e0d\u53ef\u7528' : '\u884c\u60c5\u4e0d\u53ef\u7528\uff0c\u76c8\u4e8f\u4ec5\u4f9b\u53c2\u8003'}</p> : null}
    </article>
  );
};

const StockMasterHoldingsPage: React.FC = () => {
  const [snapshot, setSnapshot] = useState<PortfolioSnapshotResponse | null>(null);
  const [quotes, setQuotes] = useState<QuoteMap>({});
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ symbol: '', quantity: '', averageCost: '' });
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async (forceRefresh = false) => {
    setLoading(true);
    try {
      if (forceRefresh) stocksApi.invalidateQuote();
      const next = await portfolioApi.getSnapshot({ includeRealtime: true });
      setSnapshot(next);
      const positions = next.accounts.flatMap((account) => account.positions);
      const entries = await Promise.all(positions.map(async (position) => {
        try {
          const quote = await stocksApi.getQuote(position.symbol);
          return [position.symbol, { previousClose: quote.prevClose, currentPrice: quote.currentPrice }] as const;
        } catch {
          return [position.symbol, {}] as const;
        }
      }));
      setQuotes(Object.fromEntries(entries));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '\u6301\u4ed3\u52a0\u8f7d\u5931\u8d25');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { document.title = 'StockMaster · 持仓'; }, []);

  const account = snapshot?.accounts[0] as PortfolioAccountSnapshot | undefined;
  const positions = useMemo(() => snapshot?.accounts.flatMap((item) => item.positions) ?? [], [snapshot]);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!account || !form.symbol.trim() || Number(form.quantity) <= 0 || Number(form.averageCost) <= 0) return;
    await portfolioApi.createTrade({ accountId: account.accountId, symbol: form.symbol.trim(), tradeDate: new Date().toISOString().slice(0, 10), side: 'buy', quantity: Number(form.quantity), price: Number(form.averageCost), tradeUid: `stockmaster-manual:${form.symbol.trim()}`, note: 'StockMaster manual position' });
    setForm({ symbol: '', quantity: '', averageCost: '' });
    setShowForm(false);
    await load(true);
  };

  return (
    <div className="sm-reference-page mx-auto flex h-full w-full max-w-6xl flex-col gap-5 overflow-y-auto p-4 md:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-xs uppercase tracking-[0.2em] text-primary">StockMaster</p><h1 className="mt-1 text-2xl font-semibold">{text.holdings}</h1><p className="mt-1 text-sm text-muted-text">{'\u624b\u5de5\u5f55\u5165\u7684 A \u80a1\u6301\u4ed3\u4e0e\u76c8\u4e8f'}</p></div><div className="flex gap-2"><button type="button" className="btn-secondary" onClick={() => void load(true)}><RefreshCw className="h-4 w-4" />{'\u5237\u65b0'}</button><button type="button" className="btn-primary" onClick={() => setShowForm((value) => !value)}><Plus className="h-4 w-4" />{'\u5f55\u5165\u6301\u4ed3'}</button></div></header>
      {showForm ? <form onSubmit={(event) => void submit(event)} className="grid gap-3 rounded-2xl border border-border/70 bg-card p-4 sm:grid-cols-4"><input className="input-surface rounded-xl px-3" placeholder="\u80a1\u7968\u4ee3\u7801" value={form.symbol} onChange={(event) => setForm({ ...form, symbol: event.target.value })} /><input className="input-surface rounded-xl px-3" placeholder="\u6570\u91cf" type="number" min="1" value={form.quantity} onChange={(event) => setForm({ ...form, quantity: event.target.value })} /><input className="input-surface rounded-xl px-3" placeholder="\u5e73\u5747\u6210\u672c" type="number" min="0.01" step="0.01" value={form.averageCost} onChange={(event) => setForm({ ...form, averageCost: event.target.value })} /><button className="btn-primary" type="submit">{'\u4fdd\u5b58'}</button></form> : null}
      {message ? <p className="rounded-xl border border-warning/30 bg-warning/10 p-3 text-sm text-warning">{message}</p> : null}
      <section className="grid gap-3 sm:grid-cols-4"><div className="rounded-2xl border border-border/70 bg-card p-4"><p className="text-xs text-muted-text">{text.marketValue}</p><p className="mt-2 text-xl font-semibold">{money(snapshot?.totalMarketValue)}</p></div><div className="rounded-2xl border border-border/70 bg-card p-4"><p className="text-xs text-muted-text">{text.totalPnl}</p><p className="mt-2 text-xl font-semibold">{money(snapshot?.unrealizedPnl)}</p></div><div className="rounded-2xl border border-border/70 bg-card p-4"><p className="text-xs text-muted-text">{text.dailyPnl}</p><p className="mt-2 text-sm font-semibold">{'\u6309\u6628\u6536\u8ba1\u7b97'}</p></div><div className="rounded-2xl border border-border/70 bg-card p-4"><p className="text-xs text-muted-text">{'\u6301\u4ed3\u6570\u91cf'}</p><p className="mt-2 text-xl font-semibold">{positions.length}</p></div></section>
      {loading ? <div className="rounded-2xl border border-border/70 bg-card p-8 text-center text-muted-text">{'\u6b63\u5728\u52a0\u8f7d\u6301\u4ed3...'}</div> : positions.length ? <div className="grid gap-3">{positions.map((position) => <PositionCard key={`${position.market}-${position.symbol}`} position={position} quote={quotes[position.symbol]} />)}</div> : <div className="rounded-2xl border border-dashed border-border p-12 text-center text-muted-text"><Trash2 className="mx-auto mb-3 h-6 w-6" />{'\u6682\u65e0\u6301\u4ed3\uff0c\u8bf7\u5148\u5f55\u5165\u4e00\u7b14 A \u80a1'}</div>}
    </div>
  );
};

export default StockMasterHoldingsPage;
