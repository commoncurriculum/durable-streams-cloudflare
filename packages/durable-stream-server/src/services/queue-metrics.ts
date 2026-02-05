/**
 * Queue Latency Metrics
 *
 * Queries the Cloudflare GraphQL Analytics API to retrieve
 * queue latency metrics from the queueMessageOperationsAdaptiveGroups dataset.
 */

export interface QueueLatencyBucket {
  minute: string;
  avgLagTime: number;
  messageCount: number;
}

export interface QueueLatencyMetrics {
  avgLagTime: number;
  p50LagTime: number;
  p90LagTime: number;
  p99LagTime: number;
  totalMessages: number;
  buckets: QueueLatencyBucket[];
  periodMinutes: number;
}

interface GraphQLResponse {
  data?: {
    viewer?: {
      accounts?: Array<{
        queueMessageOperationsAdaptiveGroups?: Array<{
          count: number;
          avg?: { lagTime: number };
          quantiles?: {
            lagTimeP50: number;
            lagTimeP90: number;
            lagTimeP99: number;
          };
          dimensions?: { datetimeMinute: string };
        }>;
      }>;
    };
  };
  errors?: Array<{ message: string }>;
}

interface QueueInfo {
  queue_id: string;
  queue_name: string;
}

interface ListQueuesResponse {
  success: boolean;
  result?: QueueInfo[];
  errors?: Array<{ message: string }>;
}

// Cache the queue ID lookup to avoid repeated API calls
let cachedQueueId: string | null = null;
let cacheExpiry = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Look up queue ID from queue name using Cloudflare API
 */
export async function getQueueIdByName(
  accountId: string,
  apiToken: string,
  queueName: string
): Promise<string | null> {
  // Check cache first
  if (cachedQueueId && Date.now() < cacheExpiry) {
    return cachedQueueId;
  }

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/queues`,
    {
      headers: {
        Authorization: `Bearer ${apiToken}`,
      },
    }
  );

  if (!response.ok) {
    throw new Error(`Failed to list queues: ${response.status}`);
  }

  const data = (await response.json()) as ListQueuesResponse;

  if (!data.success || !data.result) {
    throw new Error(`Failed to list queues: ${data.errors?.[0]?.message || "Unknown error"}`);
  }

  const queue = data.result.find((q) => q.queue_name === queueName);
  if (!queue) {
    return null;
  }

  // Cache the result
  cachedQueueId = queue.queue_id;
  cacheExpiry = Date.now() + CACHE_TTL_MS;

  return queue.queue_id;
}

/**
 * Query the Cloudflare GraphQL Analytics API for queue latency metrics
 */
export async function getQueueLatencyMetrics(
  accountId: string,
  apiToken: string,
  queueName: string,
  options: { minutes?: number } = {}
): Promise<QueueLatencyMetrics> {
  // Look up queue ID from name
  const queueId = await getQueueIdByName(accountId, apiToken, queueName);
  if (!queueId) {
    return {
      avgLagTime: 0,
      p50LagTime: 0,
      p90LagTime: 0,
      p99LagTime: 0,
      totalMessages: 0,
      buckets: [],
      periodMinutes: options.minutes || 60,
    };
  }
  const { minutes = 60 } = options;
  const datetimeEnd = new Date().toISOString();
  const datetimeStart = new Date(Date.now() - minutes * 60 * 1000).toISOString();

  const query = `
    query QueueLatency($accountTag: String!, $queueId: String!, $datetimeStart: Time!, $datetimeEnd: Time!) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          queueMessageOperationsAdaptiveGroups(
            limit: 1000
            filter: {
              queueId: $queueId
              datetime_geq: $datetimeStart
              datetime_leq: $datetimeEnd
              actionType: "ReadMessage"
            }
            orderBy: [datetimeMinute_DESC]
          ) {
            count
            avg { lagTime }
            quantiles { lagTimeP50 lagTimeP90 lagTimeP99 }
            dimensions { datetimeMinute }
          }
        }
      }
    }
  `;

  const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query,
      variables: {
        accountTag: accountId,
        queueId,
        datetimeStart,
        datetimeEnd,
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GraphQL query failed: ${response.status} ${text}`);
  }

  const result = (await response.json()) as GraphQLResponse;

  if (result.errors && result.errors.length > 0) {
    throw new Error(`GraphQL query failed: ${result.errors[0].message}`);
  }

  const groups = result.data?.viewer?.accounts?.[0]?.queueMessageOperationsAdaptiveGroups || [];

  if (groups.length === 0) {
    return {
      avgLagTime: 0,
      p50LagTime: 0,
      p90LagTime: 0,
      p99LagTime: 0,
      totalMessages: 0,
      buckets: [],
      periodMinutes: minutes,
    };
  }

  // Calculate aggregate metrics from all buckets
  let totalLagTimeWeighted = 0;
  let totalMessages = 0;
  let p50Sum = 0;
  let p90Sum = 0;
  let p99Sum = 0;
  let countWithQuantiles = 0;

  const buckets: QueueLatencyBucket[] = [];

  for (const group of groups) {
    const count = group.count || 0;
    const avgLag = group.avg?.lagTime || 0;

    totalLagTimeWeighted += avgLag * count;
    totalMessages += count;

    if (group.quantiles) {
      p50Sum += group.quantiles.lagTimeP50;
      p90Sum += group.quantiles.lagTimeP90;
      p99Sum += group.quantiles.lagTimeP99;
      countWithQuantiles++;
    }

    if (group.dimensions?.datetimeMinute) {
      buckets.push({
        minute: group.dimensions.datetimeMinute,
        avgLagTime: Math.round(avgLag),
        messageCount: count,
      });
    }
  }

  // Sort buckets by time ascending for display
  buckets.sort((a, b) => a.minute.localeCompare(b.minute));

  return {
    avgLagTime: totalMessages > 0 ? Math.round(totalLagTimeWeighted / totalMessages) : 0,
    p50LagTime: countWithQuantiles > 0 ? Math.round(p50Sum / countWithQuantiles) : 0,
    p90LagTime: countWithQuantiles > 0 ? Math.round(p90Sum / countWithQuantiles) : 0,
    p99LagTime: countWithQuantiles > 0 ? Math.round(p99Sum / countWithQuantiles) : 0,
    totalMessages,
    buckets,
    periodMinutes: minutes,
  };
}
