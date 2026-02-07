export interface CoreService {
  inspectStream(doKey: string): Promise<object>;
  routeRequest(doKey: string, request: Request): Promise<Response>;
  putStream(doKey: string, options?: { body?: ArrayBuffer; contentType?: string }): Promise<{ ok: boolean; status: number }>;
  postStream(
    doKey: string,
    payload: ArrayBuffer,
    contentType: string,
  ): Promise<{ ok: boolean; status: number; nextOffset: string | null; body: string | null }>;
  readStream(
    doKey: string,
    offset: string,
  ): Promise<{ ok: boolean; status: number; body: string; nextOffset: string | null; upToDate: boolean; contentType: string }>;
}

export type AnalyticsRow = Record<string, string | number | null>;
