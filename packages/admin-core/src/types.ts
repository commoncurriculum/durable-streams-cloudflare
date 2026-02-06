export interface CoreService {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  inspectStream(doKey: string): Promise<object>;
  routeRequest(doKey: string, request: Request): Promise<Response>;
}

export type AnalyticsRow = Record<string, string | number | null>;
