export type SseClient = {
  id: number;
  writer: WritableStreamDefaultWriter<Uint8Array>;
  offset: number;
  contentType: string;
  useBase64: boolean;
  closed: boolean;
  cursor: string;
  closeTimer?: number;
};

export type SseState = {
  clients: Map<number, SseClient>;
  nextId: number;
};
