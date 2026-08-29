import apiClient from './index';
import { toCamelCase } from './utils';
import { getOrCreateCached, invalidateCached } from '../features/stockmaster/requestCache';

export type StockQuote = {
  stockCode: string;
  stockName?: string;
  currentPrice?: number;
  changePercent?: number;
  prevClose?: number;
  updateTime?: string;
  source?: string | null;
  providerTimestamp?: string | null;
  fetchedAt?: string | null;
  lastSuccessAt?: string | null;
  isStale?: boolean;
  staleSeconds?: number | null;
  refreshStatus?: 'fresh' | 'cached' | 'stale' | 'failed';
  failureCount?: number;
  nextRetryAt?: string | null;
};

export type StockQuoteBatchResponse = {
  items: StockQuote[];
  failedCodes: string[];
  updateTime: string;
};

export type StockQuoteRefreshPolicy = {
  market: 'cn';
  phase: 'premarket' | 'intraday' | 'lunch_break' | 'closing_auction' | 'postmarket' | 'non_trading' | 'unknown';
  isTradingDay?: boolean | null;
  isMarketOpenNow?: boolean | null;
  marketLocalTime: string;
  nextTransitionAt?: string | null;
};

export type ExtractItem = {
  code?: string | null;
  name?: string | null;
  confidence: string;
};

export type ExtractFromImageResponse = {
  codes: string[];
  items?: ExtractItem[];
  rawText?: string;
};

export const stocksApi = {
  async getQuote(stockCode: string): Promise<StockQuote> {
    return getOrCreateCached(`quote:${stockCode}`, async () => {
      const response = await apiClient.get<Record<string, unknown>>(
        `/api/v1/stocks/${encodeURIComponent(stockCode)}/quote`,
      );
      return toCamelCase<StockQuote>(response.data);
    });
  },

  async getQuotes(stockCodes: string[]): Promise<StockQuoteBatchResponse> {
    const response = await apiClient.post<Record<string, unknown>>(
      '/api/v1/stocks/quotes',
      { stock_codes: stockCodes },
    );
    return toCamelCase<StockQuoteBatchResponse>(response.data);
  },

  async getQuoteRefreshPolicy(): Promise<StockQuoteRefreshPolicy> {
    const response = await apiClient.get<Record<string, unknown>>(
      '/api/v1/stocks/quotes/refresh-policy',
    );
    return toCamelCase<StockQuoteRefreshPolicy>(response.data);
  },

  invalidateQuote(stockCode?: string): void {
    invalidateCached(stockCode ? `quote:${stockCode}` : undefined);
  },

  async extractFromImage(file: File): Promise<ExtractFromImageResponse> {
    const formData = new FormData();
    formData.append('file', file);

    const headers: { [key: string]: string | undefined } = { 'Content-Type': undefined };
    const response = await apiClient.post(
      '/api/v1/stocks/extract-from-image',
      formData,
      {
        headers,
        timeout: 60000, // Vision API can be slow; 60s
      },
    );

    const data = response.data as { codes?: string[]; items?: ExtractItem[]; raw_text?: string };
    return {
      codes: data.codes ?? [],
      items: data.items,
      rawText: data.raw_text,
    };
  },

  async parseImport(file?: File, text?: string): Promise<ExtractFromImageResponse> {
    if (file) {
      const formData = new FormData();
      formData.append('file', file);
      const headers: { [key: string]: string | undefined } = { 'Content-Type': undefined };
      const response = await apiClient.post('/api/v1/stocks/parse-import', formData, { headers });
      const data = response.data as { codes?: string[]; items?: ExtractItem[] };
      return { codes: data.codes ?? [], items: data.items };
    }
    if (text) {
      const response = await apiClient.post('/api/v1/stocks/parse-import', { text });
      const data = response.data as { codes?: string[]; items?: ExtractItem[] };
      return { codes: data.codes ?? [], items: data.items };
    }
    throw new Error('请提供文件或粘贴文本');
  },
};
