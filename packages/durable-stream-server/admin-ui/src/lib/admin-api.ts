// Types matching server schemas
export interface ServiceStatus {
  available: boolean;
  latencyMs?: number;
  error?: string;
}

export interface HealthResponse {
  status: "healthy" | "degraded" | "unhealthy";
  timestamp: number;
  version?: string;
  services?: {
    registry?: ServiceStatus;
    d1?: ServiceStatus;
    r2?: ServiceStatus;
  };
}

export interface StreamInfo {
  streamId: string;
  contentType: string;
  closed: boolean;
  createdAt: number;
  expiresAt: number | null;
  messageCount?: number;
  byteSize?: number;
}

export interface StreamDetail extends StreamInfo {
  segmentCount?: number;
  totalBytes?: number;
  subscriberCount?: number;
}

export interface ListStreamsResponse {
  streams: StreamInfo[];
  nextCursor?: string;
  hasMore: boolean;
}

export interface SegmentInfo {
  streamId: string;
  readSeq: number;
  startOffset: number;
  endOffset: number;
  r2Key: string;
  contentType: string;
  createdAt: number;
  expiresAt: number | null;
  sizeBytes: number;
  messageCount: number;
}

export interface ListSegmentsResponse {
  segments: SegmentInfo[];
  nextCursor?: number;
  hasMore: boolean;
}

export interface SessionInfo {
  sessionId: string;
  createdAt: number;
  expiresAt: number;
  subscriptionCount: number;
}

export interface SessionDetail extends SessionInfo {
  subscribedStreams?: string[];
}

export interface ListSessionsResponse {
  sessions: SessionInfo[];
  nextCursor?: string;
  hasMore: boolean;
}

// API client base URL - uses same origin
const getBaseUrl = () => {
  if (typeof window === "undefined") return "";
  return window.location.origin;
};

class AdminApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
    this.name = "AdminApiError";
  }
}

async function fetchJson<T>(path: string, options?: RequestInit): Promise<T> {
  const baseUrl = getBaseUrl();
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new AdminApiError(response.status, text || `HTTP ${response.status}`);
  }

  return response.json() as Promise<T>;
}

// Health API
export async function getHealth(): Promise<HealthResponse> {
  return fetchJson<HealthResponse>("/api/health");
}

// Streams API
export async function listStreams(options?: {
  limit?: number;
  cursor?: string;
  prefix?: string;
}): Promise<ListStreamsResponse> {
  const params = new URLSearchParams();
  if (options?.limit) params.set("limit", options.limit.toString());
  if (options?.cursor) params.set("cursor", options.cursor);
  if (options?.prefix) params.set("prefix", options.prefix);

  const query = params.toString();
  return fetchJson<ListStreamsResponse>(`/api/streams${query ? `?${query}` : ""}`);
}

export async function getStream(streamId: string): Promise<StreamDetail> {
  return fetchJson<StreamDetail>(`/api/streams/${encodeURIComponent(streamId)}`);
}

export async function listSegments(
  streamId: string,
  options?: {
    limit?: number;
    after?: number;
  }
): Promise<ListSegmentsResponse> {
  const params = new URLSearchParams();
  if (options?.limit) params.set("limit", options.limit.toString());
  if (options?.after !== undefined) params.set("after", options.after.toString());

  const query = params.toString();
  return fetchJson<ListSegmentsResponse>(
    `/api/streams/${encodeURIComponent(streamId)}/segments${query ? `?${query}` : ""}`
  );
}

// Sessions API
export async function listSessions(options?: {
  limit?: number;
  cursor?: string;
}): Promise<ListSessionsResponse> {
  const params = new URLSearchParams();
  if (options?.limit) params.set("limit", options.limit.toString());
  if (options?.cursor) params.set("cursor", options.cursor);

  const query = params.toString();
  return fetchJson<ListSessionsResponse>(`/api/sessions${query ? `?${query}` : ""}`);
}

export async function getSession(sessionId: string): Promise<SessionDetail> {
  return fetchJson<SessionDetail>(`/api/sessions/${encodeURIComponent(sessionId)}`);
}

// Metrics API types
export interface HotStream {
  streamId: string;
  messageCount: number;
  byteCount: number;
}

export interface HotStreamsResponse {
  streams: HotStream[];
  periodMinutes: number;
}

export interface SystemMetrics {
  messagesLast5Min: number;
  bytesLast5Min: number;
  messagesPerSecond: number;
  activeSubscribers: number;
}

export interface ThroughputBucket {
  timestamp: number;
  messages: number;
  bytes: number;
}

export interface StreamThroughputResponse {
  streamId: string;
  buckets: ThroughputBucket[];
  avgMessagesPerMinute: number;
  periodMinutes: number;
}

export interface StreamSubscribersResponse {
  streamId: string;
  activeSubscribers: number;
}

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

// Metrics API
export async function getHotStreams(options?: {
  minutes?: number;
  limit?: number;
}): Promise<HotStreamsResponse> {
  const params = new URLSearchParams();
  if (options?.minutes) params.set("minutes", options.minutes.toString());
  if (options?.limit) params.set("limit", options.limit.toString());

  const query = params.toString();
  return fetchJson<HotStreamsResponse>(`/api/metrics/hot${query ? `?${query}` : ""}`);
}

export async function getSystemMetrics(): Promise<SystemMetrics> {
  return fetchJson<SystemMetrics>("/api/metrics/system");
}

export async function getStreamThroughput(
  streamId: string,
  options?: { minutes?: number }
): Promise<StreamThroughputResponse> {
  const params = new URLSearchParams();
  if (options?.minutes) params.set("minutes", options.minutes.toString());

  const query = params.toString();
  return fetchJson<StreamThroughputResponse>(
    `/api/metrics/streams/${encodeURIComponent(streamId)}/throughput${query ? `?${query}` : ""}`
  );
}

export async function getStreamSubscribers(
  streamId: string
): Promise<StreamSubscribersResponse> {
  return fetchJson<StreamSubscribersResponse>(
    `/api/metrics/streams/${encodeURIComponent(streamId)}/subscribers`
  );
}

export async function getQueueLatency(options?: {
  minutes?: number;
}): Promise<QueueLatencyMetrics> {
  const params = new URLSearchParams();
  if (options?.minutes) params.set("minutes", options.minutes.toString());

  const query = params.toString();
  return fetchJson<QueueLatencyMetrics>(`/api/metrics/queue/latency${query ? `?${query}` : ""}`);
}

// Export error class for handling
export { AdminApiError };
