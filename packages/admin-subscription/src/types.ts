export interface CoreService {
  routeRequest(doKey: string, request: Request): Promise<Response>;
  putStream(
    doKey: string,
    options: { contentType?: string },
  ): Promise<{ ok: boolean; status: number; body: string | null }>;
  registerProject(
    projectId: string,
    signingSecret: string,
    options?: { corsOrigins?: string[] },
  ): Promise<void>;
  addSigningKey(projectId: string, newSecret: string): Promise<{ keyCount: number }>;
  removeSigningKey(projectId: string, secretToRemove: string): Promise<{ keyCount: number }>;
  addCorsOrigin(projectId: string, origin: string): Promise<void>;
  removeCorsOrigin(projectId: string, origin: string): Promise<void>;
  listProjects(): Promise<string[]>;
  listProjectStreams(projectId: string): Promise<{ streamId: string; createdAt: number }[]>;
  getProjectConfig(projectId: string): Promise<{
    signingSecrets: string[];
    corsOrigins?: string[];
    isPublic?: boolean;
  } | null>;
  getStreamMetadata(doKey: string): Promise<{
    public: boolean;
    content_type: string;
    created_at: number;
    readerKey?: string;
  } | null>;
}

export interface SubscriptionService {
  adminGetSession(projectId: string, sessionId: string): Promise<object>;
  adminSubscribe(
    projectId: string,
    streamId: string,
    sessionId: string,
    contentType?: string,
  ): Promise<object>;
  adminUnsubscribe(projectId: string, streamId: string, sessionId: string): Promise<object>;
  adminPublish(
    projectId: string,
    streamId: string,
    payload: ArrayBuffer,
    contentType: string,
  ): Promise<object>;
  adminTouchSession(projectId: string, sessionId: string, contentType?: string): Promise<object>;
  adminDeleteSession(projectId: string, sessionId: string): Promise<object>;
}

export type AnalyticsRow = Record<string, string | number | null>;
