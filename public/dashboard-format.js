export function formatPercent(value) {
  return Number.isFinite(value) ? `${Math.round(value)}%` : 'Unavailable';
}
