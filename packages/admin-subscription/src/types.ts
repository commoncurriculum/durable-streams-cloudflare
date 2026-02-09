export interface CoreService {
  routeRequest(doKey: string, request: Request): Promise<Response>;
  putStream(doKey: string, options: { contentType: string }): Promise<{ ok: boolean; status: number; body: string | null }>;
  registerProject(projectId: string, signingSecret: string): Promise<void>;
}

export interface SubscriptionService {
  adminGetSession(projectId: string, sessionId: string): Promise<object>;
  adminSubscribe(projectId: string, streamId: string, sessionId: string, contentType?: string): Promise<object>;
  adminUnsubscribe(projectId: string, streamId: string, sessionId: string): Promise<object>;
  adminPublish(projectId: string, streamId: string, payload: ArrayBuffer, contentType: string): Promise<object>;
  adminTouchSession(projectId: string, sessionId: string): Promise<object>;
  adminDeleteSession(projectId: string, sessionId: string): Promise<object>;
}

export type AnalyticsRow = Record<string, string | number | null>;
