import { useEffect, useRef, useState } from 'react';
import { stocksApi, type StockQuoteRefreshPolicy } from '../api/stocks';

const ACTIVE_MARKET_REFRESH_MS = 5_000;
const BATCH_ANALYSIS_REFRESH_MS = 30_000;
const POLICY_RETRY_MS = 30_000;
const MIN_TRANSITION_DELAY_MS = 250;
const MAX_TIMER_DELAY_MS = 2_147_000_000;

function isWindowActive(): boolean {
  return document.visibilityState === 'visible'
    && (typeof document.hasFocus !== 'function' || document.hasFocus());
}

function nextDelayMs(policy: StockQuoteRefreshPolicy, isBatchAnalyzing: boolean): number | null {
  if (policy.isMarketOpenNow === true) {
    return isBatchAnalyzing ? BATCH_ANALYSIS_REFRESH_MS : ACTIVE_MARKET_REFRESH_MS;
  }
  if (!policy.nextTransitionAt) return null;

  const transitionAt = Date.parse(policy.nextTransitionAt);
  if (!Number.isFinite(transitionAt)) return null;
  return Math.min(
    MAX_TIMER_DELAY_MS,
    Math.max(MIN_TRANSITION_DELAY_MS, transitionAt - Date.now()),
  );
}

type UseAshareQuoteRefreshOptions = {
  refresh: () => Promise<void>;
  refreshKey: string;
  isBatchAnalyzing: boolean;
};

export type AShareQuoteRefreshState = {
  policy: StockQuoteRefreshPolicy | null;
  policyUnavailable: boolean;
  cadenceMs: number | null;
};

/**
 * Schedule A-share watchlist quotes from the exchange calendar.
 *
 * Opening the page or focusing the window rechecks the exchange policy, but
 * only touches a quote provider while the CN market is open. Automatic
 * refreshes pause over lunch/weekends/holidays and slow down while a
 * watchlist batch is consuming the same public data providers.
 */
export function useAshareQuoteRefresh({
  refresh,
  refreshKey,
  isBatchAnalyzing,
}: UseAshareQuoteRefreshOptions): AShareQuoteRefreshState {
  const [state, setState] = useState<AShareQuoteRefreshState>({
    policy: null,
    policyUnavailable: false,
    cadenceMs: null,
  });
  const refreshRef = useRef(refresh);
  const refreshKeyRef = useRef(refreshKey);
  const batchAnalyzingRef = useRef(isBatchAnalyzing);
  const rescheduleRef = useRef<(() => void) | null>(null);
  const refreshNowRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  useEffect(() => {
    const changed = refreshKeyRef.current !== refreshKey;
    refreshKeyRef.current = refreshKey;
    if (changed) refreshNowRef.current?.();
  }, [refreshKey]);

  useEffect(() => {
    batchAnalyzingRef.current = isBatchAnalyzing;
    rescheduleRef.current?.();
  }, [isBatchAnalyzing]);

  useEffect(() => {
    let disposed = false;
    let timerId: number | null = null;
    let generation = 0;

    const clearTimer = () => {
      if (timerId !== null) {
        window.clearTimeout(timerId);
        timerId = null;
      }
    };

    type RefreshMode = 'force' | 'if-open' | 'none';

    const runCycle = async (refreshMode: RefreshMode) => {
      const cycleGeneration = ++generation;
      clearTimer();
      if (disposed || (refreshMode !== 'force' && !isWindowActive())) return;

      let policy: StockQuoteRefreshPolicy;
      try {
        policy = await stocksApi.getQuoteRefreshPolicy();
      } catch {
        if (!disposed && cycleGeneration === generation && isWindowActive()) {
          setState((current) => ({
            ...current,
            policyUnavailable: true,
            cadenceMs: null,
          }));
          timerId = window.setTimeout(() => void runCycle('if-open'), POLICY_RETRY_MS);
        }
        return;
      }

      if (disposed || cycleGeneration !== generation || !isWindowActive()) return;

      // Opening/focusing the page is only a scheduling trigger. Check the
      // exchange calendar before touching a public quote provider so repeated
      // Electron focus events cannot fetch quotes after close or on holidays.
      if (refreshMode !== 'none' && policy.isMarketOpenNow === true) {
        await refreshRef.current().catch(() => undefined);
        if (disposed || cycleGeneration !== generation || !isWindowActive()) return;
      }

      const delay = nextDelayMs(policy, batchAnalyzingRef.current);
      setState({
        policy,
        policyUnavailable: false,
        cadenceMs: policy.isMarketOpenNow === true
          ? (batchAnalyzingRef.current ? BATCH_ANALYSIS_REFRESH_MS : ACTIVE_MARKET_REFRESH_MS)
          : null,
      });
      if (delay !== null) {
        timerId = window.setTimeout(() => void runCycle('if-open'), delay);
      }
    };

    rescheduleRef.current = () => void runCycle('none');
    refreshNowRef.current = () => void runCycle('force');
    let wasWindowActive = isWindowActive();
    const refreshAfterActivation = () => {
      const active = isWindowActive();
      if (!active) {
        wasWindowActive = false;
        return;
      }
      if (wasWindowActive) return;
      wasWindowActive = true;
      void runCycle('force');
    };
    const markWindowInactive = () => {
      wasWindowActive = false;
    };

    void runCycle('force');
    window.addEventListener('focus', refreshAfterActivation);
    window.addEventListener('blur', markWindowInactive);
    document.addEventListener('visibilitychange', refreshAfterActivation);

    return () => {
      disposed = true;
      generation += 1;
      clearTimer();
      rescheduleRef.current = null;
      refreshNowRef.current = null;
      window.removeEventListener('focus', refreshAfterActivation);
      window.removeEventListener('blur', markWindowInactive);
      document.removeEventListener('visibilitychange', refreshAfterActivation);
    };
  }, []);

  return state;
}
