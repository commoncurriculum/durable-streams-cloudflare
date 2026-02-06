export interface CoreService {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  routeRequest(doKey: string, request: Request): Promise<Response>;
}

export interface SubscriptionService {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  adminGetSession(projectId: string, sessionId: string): Promise<object>;
  adminSubscribe(projectId: string, streamId: string, sessionId: string, contentType?: string): Promise<object>;
  adminUnsubscribe(projectId: string, streamId: string, sessionId: string): Promise<object>;
  adminPublish(projectId: string, streamId: string, payload: ArrayBuffer, contentType: string): Promise<object>;
  adminTouchSession(projectId: string, sessionId: string): Promise<object>;
  adminDeleteSession(projectId: string, sessionId: string): Promise<object>;
}

export type AnalyticsRow = Record<string, string | number | null>;
