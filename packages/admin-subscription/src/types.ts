export interface CoreService {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  routeRequest(doKey: string, request: Request): Promise<Response>;
}

export interface SubscriptionService {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  adminGetSession(projectId: string, sessionId: string): Promise<unknown>;
  adminSubscribe(projectId: string, streamId: string, sessionId: string, contentType?: string): Promise<unknown>;
  adminUnsubscribe(projectId: string, streamId: string, sessionId: string): Promise<unknown>;
  adminPublish(projectId: string, streamId: string, payload: ArrayBuffer, contentType: string): Promise<unknown>;
  adminTouchSession(projectId: string, sessionId: string): Promise<unknown>;
  adminDeleteSession(projectId: string, sessionId: string): Promise<unknown>;
}

export type AnalyticsRow = Record<string, string | number | null>;
