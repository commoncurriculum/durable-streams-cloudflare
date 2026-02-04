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
  return fetchJson<HealthResponse>("/admin/api/health");
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
  return fetchJson<ListStreamsResponse>(`/admin/api/streams${query ? `?${query}` : ""}`);
}

export async function getStream(streamId: string): Promise<StreamDetail> {
  return fetchJson<StreamDetail>(`/admin/api/streams/${encodeURIComponent(streamId)}`);
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
    `/admin/api/streams/${encodeURIComponent(streamId)}/segments${query ? `?${query}` : ""}`
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
  return fetchJson<ListSessionsResponse>(`/admin/api/sessions${query ? `?${query}` : ""}`);
}

export async function getSession(sessionId: string): Promise<SessionDetail> {
  return fetchJson<SessionDetail>(`/admin/api/sessions/${encodeURIComponent(sessionId)}`);
}

// Export error class for handling
export { AdminApiError };
