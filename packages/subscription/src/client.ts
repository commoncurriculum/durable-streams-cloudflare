export type StreamRpcResult = { ok: boolean; status: number; body: string | null; contentType?: string | null };
export type PostStreamResult = { ok: boolean; status: number; nextOffset: string | null; upToDate: string | null; streamClosed: string | null; body: string | null };

export interface CoreService {
  headStream(doKey: string): Promise<StreamRpcResult>;
  putStream(doKey: string, options: { expiresAt?: number; body?: ArrayBuffer; contentType: string }): Promise<StreamRpcResult>;
  deleteStream(doKey: string): Promise<StreamRpcResult>;
  postStream(
    doKey: string,
    payload: ArrayBuffer,
    contentType: string,
    producerHeaders?: { producerId: string; producerEpoch: string; producerSeq: string },
  ): Promise<PostStreamResult>;
}
