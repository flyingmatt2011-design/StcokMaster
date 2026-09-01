import type React from 'react';
import type { KronosForecast } from '../../types/analysis';
import { useUiLanguage } from '../../contexts/UiLanguageContext';

interface KronosForecastPanelProps {
  forecast: KronosForecast;
}

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const formatPrice = (value?: number | null): string =>
  finite(value) ? value.toFixed(2) : '--';

const formatPct = (value?: number | null): string => {
  if (!finite(value)) return '--';
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
};

const buildPolyline = (values: number[], startIndex: number, totalPoints: number, min: number, max: number): string => {
  const range = Math.max(max - min, 0.0001);
  return values.map((value, index) => {
    const absoluteIndex = startIndex + index;
    const x = totalPoints <= 1 ? 0 : (absoluteIndex / (totalPoints - 1)) * 100;
    const y = 30 - ((value - min) / range) * 26;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(' ');
};

export const KronosForecastPanel: React.FC<KronosForecastPanelProps> = ({ forecast }) => {
  const { t } = useUiLanguage();
  const historical = (forecast.historicalPoints || []).filter((point) => finite(point.close));
  const predicted = (forecast.forecastPoints || []).filter((point) => finite(point.close));
  const historyTail = historical.slice(-12);
  const historyValues = historyTail.map((point) => point.close as number);
  const predictedValues = predicted.map((point) => point.close as number);
  const chartValues = [...historyValues, ...predictedValues];
  const min = chartValues.length > 0 ? Math.min(...chartValues) : 0;
  const max = chartValues.length > 0 ? Math.max(...chartValues) : 1;
  const forecastPathValues = historyValues.length > 0
    ? [historyValues[historyValues.length - 1], ...predictedValues]
    : predictedValues;
  const forecastStartIndex = Math.max(historyValues.length - 1, 0);
  const directionLabel = forecast.direction === 'bullish'
    ? t('terminal.kronosDirection.bullish')
    : forecast.direction === 'bearish'
      ? t('terminal.kronosDirection.bearish')
      : forecast.direction === 'neutral'
        ? t('terminal.kronosDirection.neutral')
        : '--';
  const unavailableMessage = forecast.reason === 'model_not_configured'
    ? t('terminal.kronosNotConfigured')
    : forecast.reason === 'optional_dependency_missing'
      ? t('terminal.kronosDependencyMissing')
      : forecast.reason === 'insufficient_daily_bars'
        ? t('terminal.kronosInsufficientData')
        : t('terminal.kronosInferenceFailed');
  const returnTone = finite(forecast.predictedReturnPct)
    ? forecast.predictedReturnPct > 0
      ? 'term-up'
      : forecast.predictedReturnPct < 0
        ? 'term-down'
        : ''
    : '';

  return (
    <section className="terminal-report-panel terminal-kronos-panel" data-testid="kronos-forecast-panel">
      <header>
        <div>
          <h3>{t('terminal.kronosTitle')}</h3>
          <small className="terminal-kronos-subtitle">{t('terminal.kronosSubtitle')}</small>
        </div>
        <span className="terminal-kronos-badge">{t('terminal.kronosNotScored')}</span>
      </header>

      {forecast.status !== 'success' ? (
        <div className="terminal-kronos-unavailable" role="status">
          <strong>{t('terminal.kronosUnavailable')}</strong>
          <span>{unavailableMessage}</span>
        </div>
      ) : (
        <>
          <div className="terminal-kronos-metrics">
            <div><span>{t('terminal.kronosAsOfClose')}</span><strong className="terminal-mono">{formatPrice(forecast.currentClose)}</strong></div>
            <div><span>{t('terminal.kronosFinalClose')}</span><strong className="terminal-mono">{formatPrice(forecast.predictedFinalClose)}</strong></div>
            <div><span>{t('terminal.kronosReturn')}</span><strong className={`terminal-mono ${returnTone}`}>{formatPct(forecast.predictedReturnPct)}</strong></div>
            <div><span>{t('terminal.kronosDirectionLabel')}</span><strong>{directionLabel}</strong></div>
          </div>

          {chartValues.length >= 2 ? (
            <div className="terminal-kronos-chart">
              <svg viewBox="0 0 100 34" preserveAspectRatio="none" role="img" aria-label={t('terminal.kronosChartLabel')}>
                <line x1="0" y1="30" x2="100" y2="30" className="terminal-kronos-axis" />
                {historyValues.length >= 2 ? <polyline points={buildPolyline(historyValues, 0, chartValues.length, min, max)} className="terminal-kronos-history-line" /> : null}
                {forecastPathValues.length >= 2 ? <polyline points={buildPolyline(forecastPathValues, forecastStartIndex, chartValues.length, min, max)} className="terminal-kronos-forecast-line" /> : null}
                {historyValues.length > 0 && predictedValues.length > 0 ? (
                  <line
                    x1={(forecastStartIndex / (chartValues.length - 1)) * 100}
                    y1="2"
                    x2={(forecastStartIndex / (chartValues.length - 1)) * 100}
                    y2="31"
                    className="terminal-kronos-divider"
                  />
                ) : null}
              </svg>
              <div><span>{t('terminal.kronosHistory')}</span><span>{t('terminal.kronosForecast')}</span></div>
            </div>
          ) : null}

          <div className="terminal-kronos-days" aria-label={t('terminal.kronosForecastDays')}>
            {predicted.map((point) => (
              <div key={point.date}>
                <time className="terminal-mono">{point.date.slice(5)}</time>
                <strong className="terminal-mono">{formatPrice(point.close)}</strong>
                <small className="terminal-mono">{formatPrice(point.low)} / {formatPrice(point.high)}</small>
              </div>
            ))}
          </div>

          <footer className="terminal-kronos-meta">
            <span>{t('terminal.kronosAsOf')}: {forecast.asOf || '--'}</span>
            <span>{t('terminal.kronosHorizon')}: {forecast.horizon ?? predicted.length}</span>
            <span>{forecast.model || 'Kronos'}</span>
          </footer>
        </>
      )}
    </section>
  );
};
