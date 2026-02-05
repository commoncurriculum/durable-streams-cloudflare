import { randomUUID } from "node:crypto";

export function uniqueSessionId(prefix = "session"): string {
  return `${prefix}-${randomUUID()}`;
}

export function uniqueStreamId(prefix = "stream"): string {
  return `${prefix}-${randomUUID()}`;
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface SubscriptionsClient {
  subscribe(sessionId: string, streamId: string, contentType?: string): Promise<Response>;
  unsubscribe(sessionId: string, streamId: string): Promise<Response>;
  publish(streamId: string, payload: string, contentType?: string): Promise<Response>;
  getSession(sessionId: string): Promise<Response>;
  touchSession(sessionId: string): Promise<Response>;
  deleteSession(sessionId: string): Promise<Response>;
  reconcile(cleanup?: boolean): Promise<Response>;
}

export function createSubscriptionsClient(baseUrl: string): SubscriptionsClient {
  return {
    async subscribe(sessionId: string, streamId: string, contentType = "application/json") {
      return fetch(`${baseUrl}/v1/subscribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, streamId, contentType }),
      });
    },

    async unsubscribe(sessionId: string, streamId: string) {
      return fetch(`${baseUrl}/v1/unsubscribe`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, streamId }),
      });
    },

    async publish(streamId: string, payload: string, contentType = "application/json") {
      return fetch(`${baseUrl}/v1/publish/${streamId}`, {
        method: "POST",
        headers: { "Content-Type": contentType },
        body: payload,
      });
    },

    async getSession(sessionId: string) {
      return fetch(`${baseUrl}/v1/session/${sessionId}`);
    },

    async touchSession(sessionId: string) {
      return fetch(`${baseUrl}/v1/session/${sessionId}/touch`, {
        method: "POST",
      });
    },

    async deleteSession(sessionId: string) {
      return fetch(`${baseUrl}/v1/session/${sessionId}`, {
        method: "DELETE",
      });
    },

    async reconcile(cleanup = false) {
      const url = cleanup
        ? `${baseUrl}/v1/internal/reconcile?cleanup=true`
        : `${baseUrl}/v1/internal/reconcile`;
      return fetch(url);
    },
  };
}

export interface CoreClient {
  createStream(streamId: string, content?: string, contentType?: string): Promise<Response>;
  appendStream(streamId: string, content: string, contentType?: string): Promise<Response>;
  readStream(streamId: string, offset?: string): Promise<Response>;
  readStreamText(streamId: string, offset?: string): Promise<string>;
  deleteStream(streamId: string): Promise<Response>;
  getStreamHead(streamId: string): Promise<Response>;
}

export function createCoreClient(baseUrl: string): CoreClient {
  return {
    async createStream(streamId: string, content = "", contentType = "application/json") {
      // Only include body if content is non-empty.
      // Node.js fetch may strip Content-Type header when body is empty string.
      const options: RequestInit = {
        method: "PUT",
        headers: { "Content-Type": contentType },
      };
      if (content) {
        options.body = content;
      }
      return fetch(`${baseUrl}/v1/stream/${streamId}`, options);
    },

    async appendStream(streamId: string, content: string, contentType = "application/json") {
      return fetch(`${baseUrl}/v1/stream/${streamId}`, {
        method: "POST",
        headers: { "Content-Type": contentType },
        body: content,
      });
    },

    async readStream(streamId: string, offset = "0000000000000000_0000000000000000") {
      return fetch(`${baseUrl}/v1/stream/${streamId}?offset=${offset}`);
    },

    async readStreamText(streamId: string, offset = "0000000000000000_0000000000000000") {
      const response = await this.readStream(streamId, offset);
      if (!response.ok) {
        throw new Error(`Failed to read stream: ${response.status}`);
      }
      return response.text();
    },

    async deleteStream(streamId: string) {
      return fetch(`${baseUrl}/v1/stream/${streamId}`, {
        method: "DELETE",
      });
    },

    async getStreamHead(streamId: string) {
      return fetch(`${baseUrl}/v1/stream/${streamId}`, {
        method: "HEAD",
      });
    },
  };
}

export interface SubscribeResponse {
  sessionId: string;
  streamId: string;
  sessionStreamPath: string;
  expiresAt: number;
  isNewSession: boolean;
}

export interface SessionResponse {
  sessionId: string;
  sessionStreamPath: string;
  subscriptions: Array<{
    streamId: string;
  }>;
}

export interface TouchResponse {
  sessionId: string;
  expiresAt: number;
}

export interface ReconcileResponse {
  message: string;
  totalSessions: number;
  validSessions: number;
  orphanedInD1: number;
  cleaned: number;
}
