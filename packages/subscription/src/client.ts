export type StreamRpcResult = { ok: boolean; status: number };
export type PostStreamResult = { ok: boolean; status: number; nextOffset: string | null; body: string | null };

export interface CoreService {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  routeRequest(doKey: string, request: Request): Promise<Response>;
  headStream(doKey: string): Promise<StreamRpcResult>;
  putStream(doKey: string, options?: { expiresAt?: number }): Promise<StreamRpcResult>;
  deleteStream(doKey: string): Promise<StreamRpcResult>;
  postStream(
    doKey: string,
    payload: ArrayBuffer,
    contentType: string,
    producerHeaders?: { producerId: string; producerEpoch: string; producerSeq: string },
  ): Promise<PostStreamResult>;
}
