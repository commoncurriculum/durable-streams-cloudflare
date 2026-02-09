/**
 * Load test Worker — deployed to Cloudflare edge.
 *
 * Each invocation acts as a single reader connection to core's public URL,
 * exercising the real CDN edge cache. The orchestrator (run.ts) fires N
 * concurrent POST requests to this Worker to simulate N distributed readers.
 *
 * POST / — accepts RunConfig JSON, runs one reader, returns WorkerSummary JSON.
 */

interface Env {
  METRICS?: AnalyticsEngineDataset;
}

interface RunConfig {
  coreUrl: string;
  projectId: string;
  streamId: string;
  mode: "sse" | "long-poll";
  durationSec: number;
  authToken?: string;
  msgSize?: number;
}

interface WorkerSummary {
  eventsReceived: number;
  batches: number;
  errors: number;
  errorMessage?: string;
  cacheHeaders: Record<string, number>;
  cdnCacheHeaders: Record<string, number>;
  deliveryLatency: {
    avg: number;
    p50: number;
    p90: number;
    p99: number;
    max: number;
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("POST a RunConfig JSON body", { status: 405 });
    }

    let config: RunConfig;
    try {
      config = await request.json();
    } catch {
      return new Response("Invalid JSON body", { status: 400 });
    }

    if (!config.coreUrl || !config.projectId || !config.streamId || !config.mode || !config.durationSec) {
      return new Response("Missing required fields: coreUrl, projectId, streamId, mode, durationSec", { status: 400 });
    }

    try {
      const summary = await runReader(config, env);
      return Response.json(summary);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return Response.json({ error: message }, { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;

async function runReader(config: RunConfig, env: Env): Promise<WorkerSummary> {
  const { coreUrl, projectId, streamId, mode, durationSec, authToken } = config;
  const streamUrl = `${coreUrl}/v1/${projectId}/stream/${streamId}`;

  const headers: Record<string, string> = {};
  if (authToken) {
    headers["Authorization"] = `Bearer ${authToken}`;
  }

  // Metrics state
  let eventsReceived = 0;
  let batches = 0;
  let errors = 0;
  let errorMessage: string | undefined;
  const cacheHeaders: Record<string, number> = {};
  const cdnCacheHeaders: Record<string, number> = {};
  const latencySamples: number[] = [];
  const MAX_SAMPLES = 10_000;
  let latencyTotal = 0;
  let latencyMax = 0;

  function recordLatency(ms: number) {
    latencyTotal += ms;
    if (ms > latencyMax) latencyMax = ms;
    if (latencySamples.length < MAX_SAMPLES) {
      latencySamples.push(ms);
    } else {
      const idx = Math.floor(Math.random() * (eventsReceived + 1));
      if (idx < MAX_SAMPLES) latencySamples[idx] = ms;
    }
  }

  function recordCache(value: string | null) {
    const key = value ?? "(none)";
    cacheHeaders[key] = (cacheHeaders[key] ?? 0) + 1;
  }

  // Track latest server-side write timestamp for clock-skew-free latency
  let lastWriteTimestamp = 0;

  // Custom fetch that tracks x-cache, cf-cache-status, and Stream-Write-Timestamp headers
  const trackingFetch: typeof globalThis.fetch = async (input, init) => {
    const res = await globalThis.fetch(input, init);
    recordCache(res.headers.get("x-cache"));
    const cdnStatus = res.headers.get("cf-cache-status") ?? "(none)";
    cdnCacheHeaders[cdnStatus] = (cdnCacheHeaders[cdnStatus] ?? 0) + 1;
    const wt = res.headers.get("stream-write-timestamp");
    if (wt) lastWriteTimestamp = Number(wt);
    return res;
  };

  const deadline = Date.now() + durationSec * 1000;
  const abortController = new AbortController();

  // Set a hard timeout
  const timeout = setTimeout(() => abortController.abort(), durationSec * 1000);

  try {
    // Use the standalone stream() function from @durable-streams/client.
    // The stream is already created by the orchestrator — we just read.
    const { stream: dsStream } = await import("@durable-streams/client");

    const res = await dsStream<{ t: number; seq: number }>({
      url: streamUrl,
      live: mode,
      offset: "now",
      signal: abortController.signal,
      headers,
      fetch: trackingFetch,
      json: true,
    });

    // subscribeJson returns an unsubscribe function synchronously.
    // We need to keep the Worker alive until the abort fires, so we
    // await res.closed (a Promise that resolves when the stream ends).
    res.subscribeJson(async (batch) => {
      const now = Date.now();
      batches++;
      let batchLatency = 0;

      for (const item of batch.items) {
        eventsReceived++;
        // Prefer server-side write timestamp (no clock skew) over payload timestamp
        if (lastWriteTimestamp > 0) {
          const latency = now - lastWriteTimestamp;
          recordLatency(latency);
          batchLatency = latency;
        } else if (typeof item.t === "number") {
          const latency = now - item.t;
          recordLatency(latency);
          batchLatency = latency;
        }
      }

      // Find the most recent x-cache value seen by trackingFetch
      const lastCache = Object.keys(cacheHeaders).sort(
        (a, b) => (cacheHeaders[b] ?? 0) - (cacheHeaders[a] ?? 0),
      )[0] ?? "(none)";

      // Write per-batch data point to Analytics Engine
      env.METRICS?.writeDataPoint({
        blobs: [streamId, mode, lastCache, ""],
        doubles: [batch.items.length, batchLatency, 0, 0],
        indexes: ["loadtest"],
      });

      // Stop if past deadline
      if (Date.now() >= deadline) {
        abortController.abort();
      }
    });

    // Keep alive until the stream closes (via abort or server close)
    await res.closed;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      // Expected — duration elapsed
    } else {
      errors++;
      errorMessage = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    }
  } finally {
    clearTimeout(timeout);
  }

  // Compute latency percentiles
  const sorted = latencySamples.slice().sort((a, b) => a - b);
  const summary: WorkerSummary = {
    eventsReceived,
    batches,
    errors,
    errorMessage,
    cacheHeaders,
    cdnCacheHeaders,
    deliveryLatency: {
      avg: eventsReceived > 0 ? Math.round(latencyTotal / eventsReceived) : 0,
      p50: Math.round(percentile(sorted, 50)),
      p90: Math.round(percentile(sorted, 90)),
      p99: Math.round(percentile(sorted, 99)),
      max: Math.round(latencyMax),
    },
  };

  return summary;
}
