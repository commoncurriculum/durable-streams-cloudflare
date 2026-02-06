export interface CoreService {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}
