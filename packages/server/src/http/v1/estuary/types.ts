import { type } from "arktype";

// ============================================================================
// Response schemas — single source of truth for OpenAPI + TS types
// ============================================================================

export const subscribeResponseSchema = type({
  estuaryId: "string",
  streamId: "string",
  estuaryStreamPath: "string",
  expiresAt: "number",
  isNewEstuary: "boolean",
});

export type SubscribeResult = typeof subscribeResponseSchema.infer;

export const unsubscribeResponseSchema = type({
  success: "true",
});

export type UnsubscribeResult = typeof unsubscribeResponseSchema.infer;

export const deleteEstuaryResponseSchema = type({
  estuaryId: "string",
  deleted: "true",
});

export type DeleteEstuaryResult = typeof deleteEstuaryResponseSchema.infer;

export const touchEstuaryResponseSchema = type({
  estuaryId: "string",
  expiresAt: "number",
});

export type TouchEstuaryResult = typeof touchEstuaryResponseSchema.infer;

export const getEstuaryResponseSchema = type({
  estuaryId: "string",
  estuaryStreamPath: "string",
  subscriptions: type({ streamId: "string" }).array(),
  contentType: "string | null",
});

export type GetEstuaryResult = typeof getEstuaryResponseSchema.infer;

// ============================================================================
// Non-HTTP types (internal, not exposed via OpenAPI)
// ============================================================================

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
  producerHeaders?: {
    producerId: string;
    producerEpoch: string;
    producerSeq: string;
  };
}

export interface EstuaryInfo {
  estuaryId: string;
  estuaryStreamPath: string;
  subscriptions: Array<{ streamId: string }>;
  contentType?: string | null;
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
