export interface SubscribeResult {
  sessionId: string;
  streamId: string;
  sessionStreamPath: string;
  expiresAt: number;
  isNewSession: boolean;
}

export interface UnsubscribeResult {
  sessionId: string;
  streamId: string;
  unsubscribed: true;
}

export interface DeleteSessionResult {
  sessionId: string;
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
}

export interface SessionInfo {
  sessionId: string;
  sessionStreamPath: string;
  subscriptions: Array<{ streamId: string }>;
}

export interface TouchSessionResult {
  sessionId: string;
  expiresAt: number;
}

export interface SubscriberInfo {
  sessionId: string;
  subscribedAt: number;
}

export interface GetSubscribersResult {
  streamId: string;
  subscribers: SubscriberInfo[];
  count: number;
}
