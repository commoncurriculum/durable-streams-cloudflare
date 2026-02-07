/**
 * Metrics collection for load test runs.
 *
 * Tracks per-operation latency histograms (reservoir sampled)
 * and x-cache header distributions.
 */

export interface OpMetrics {
  count: number;
  errors: number;
  totalMs: number;
  minMs: number;
  maxMs: number;
  samples: number[];
}

export function createOpMetrics(): OpMetrics {
  return { count: 0, errors: 0, totalMs: 0, minMs: Infinity, maxMs: 0, samples: [] };
}

const MAX_SAMPLES = 10_000;

export function recordSuccess(m: OpMetrics, ms: number) {
  m.count++;
  m.totalMs += ms;
  if (ms < m.minMs) m.minMs = ms;
  if (ms > m.maxMs) m.maxMs = ms;
  if (m.samples.length < MAX_SAMPLES) {
    m.samples.push(ms);
  } else {
    const idx = Math.floor(Math.random() * m.count);
    if (idx < MAX_SAMPLES) m.samples[idx] = ms;
  }
}

export function recordError(m: OpMetrics) {
  m.count++;
  m.errors++;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

export interface OpSummary {
  count: number;
  errors: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
  p50Ms: number;
  p90Ms: number;
  p99Ms: number;
}

export function summarize(m: OpMetrics): OpSummary {
  const sorted = m.samples.slice().sort((a, b) => a - b);
  return {
    count: m.count,
    errors: m.errors,
    avgMs: m.count - m.errors > 0 ? Math.round(m.totalMs / (m.count - m.errors)) : 0,
    minMs: m.minMs === Infinity ? 0 : Math.round(m.minMs),
    maxMs: Math.round(m.maxMs),
    p50Ms: Math.round(percentile(sorted, 50)),
    p90Ms: Math.round(percentile(sorted, 90)),
    p99Ms: Math.round(percentile(sorted, 99)),
  };
}

export interface CacheStats {
  counts: Record<string, number>;
}

export function createCacheStats(): CacheStats {
  return { counts: {} };
}

export function recordCacheHeader(stats: CacheStats, value: string | null) {
  const key = value ?? "(none)";
  stats.counts[key] = (stats.counts[key] ?? 0) + 1;
}

export interface DeliveryStats {
  count: number;
  totalMs: number;
  minMs: number;
  maxMs: number;
  samples: number[];
}

export function createDeliveryStats(): DeliveryStats {
  return { count: 0, totalMs: 0, minMs: Infinity, maxMs: 0, samples: [] };
}

export function recordDelivery(stats: DeliveryStats, ms: number) {
  stats.count++;
  stats.totalMs += ms;
  if (ms < stats.minMs) stats.minMs = ms;
  if (ms > stats.maxMs) stats.maxMs = ms;
  if (stats.samples.length < MAX_SAMPLES) {
    stats.samples.push(ms);
  } else {
    const idx = Math.floor(Math.random() * stats.count);
    if (idx < MAX_SAMPLES) stats.samples[idx] = ms;
  }
}

export function summarizeDelivery(stats: DeliveryStats): OpSummary {
  const sorted = stats.samples.slice().sort((a, b) => a - b);
  return {
    count: stats.count,
    errors: 0,
    avgMs: stats.count > 0 ? Math.round(stats.totalMs / stats.count) : 0,
    minMs: stats.minMs === Infinity ? 0 : Math.round(stats.minMs),
    maxMs: Math.round(stats.maxMs),
    p50Ms: Math.round(percentile(sorted, 50)),
    p90Ms: Math.round(percentile(sorted, 90)),
    p99Ms: Math.round(percentile(sorted, 99)),
  };
}
