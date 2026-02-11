export interface SubscribeResult {
  estuaryId: string;
  streamId: string;
  estuaryStreamPath: string;
  expiresAt: number;
  isNewEstuary: boolean;
}

export interface UnsubscribeResult {
  estuaryId: string;
  streamId: string;
  unsubscribed: true;
}

export interface DeleteEstuaryResult {
  estuaryId: string;
  deleted: true;
}

export interface PublishParams {
  payload: ArrayBuffer;
  contentType: string;
  producerId?: string;
  producerEpoch?: string;
  producerSeq?: string;
}

export interface PublishResult {
  status: number;
  nextOffset: string | null;
  upToDate: string | null;
  streamClosed: string | null;
  body: string;
  fanoutCount: number;
  fanoutSuccesses: number;
  fanoutFailures: number;
  fanoutMode: "inline" | "queued" | "circuit-open" | "skipped";
}

export interface FanoutQueueMessage {
  projectId: string;
  streamId: string;
  estuaryIds: string[];
  payload: string; // base64-encoded
  contentType: string;
  producerHeaders?: { producerId: string; producerEpoch: string; producerSeq: string };
}

export interface FanoutResult {
  successes: number;
  failures: number;
  staleEstuaryIds: string[];
}

export interface EstuaryInfo {
  estuaryId: string;
  estuaryStreamPath: string;
  subscriptions: Array<{ streamId: string }>;
  contentType?: string | null;
}

export interface TouchEstuaryResult {
  estuaryId: string;
  expiresAt: number;
}

export interface SubscriberInfo {
  estuaryId: string;
  subscribedAt: number;
}

export interface GetSubscribersResult {
  streamId: string;
  subscribers: SubscriberInfo[];
  count: number;
}
