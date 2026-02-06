export interface CoreService {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  routeRequest(doKey: string, request: Request): Promise<Response>;
}
