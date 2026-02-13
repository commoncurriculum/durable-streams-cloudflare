export interface EstuaryClient {
  subscribe: (streamId: string, subscriberUrl: string, ttlSeconds?: number) => Promise<Response>;
  publish: (streamId: string, payload: string) => Promise<Response>;
  touch: (streamId: string, ttlSeconds: number) => Promise<Response>;
  get: (streamId: string) => Promise<Response>;
  delete: (streamId: string) => Promise<Response>;
  unsubscribe: (streamId: string, subscriberUrl: string) => Promise<Response>;
}

export function createClient(baseUrl: string, token: string): EstuaryClient {
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  return {
    async subscribe(streamId, subscriberUrl, ttlSeconds) {
      const body = JSON.stringify({ subscriberUrl, ttlSeconds });
      return await fetch(`${baseUrl}/v1/stream/${streamId}/subscribe`, {
        method: "POST",
        headers,
        body,
      });
    },
    async publish(streamId, payload) {
      return await fetch(`${baseUrl}/v1/stream/${streamId}/publish`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "text/plain",
        },
        body: payload,
      });
    },
    async touch(streamId, ttlSeconds) {
      const body = JSON.stringify({ ttlSeconds });
      return await fetch(`${baseUrl}/v1/stream/${streamId}/touch`, {
        method: "POST",
        headers,
        body,
      });
    },
    async get(streamId) {
      return await fetch(`${baseUrl}/v1/stream/${streamId}`, {
        method: "GET",
        headers,
      });
    },
    async delete(streamId) {
      return await fetch(`${baseUrl}/v1/stream/${streamId}`, {
        method: "DELETE",
        headers,
      });
    },
    async unsubscribe(streamId, subscriberUrl) {
      const body = JSON.stringify({ subscriberUrl });
      return await fetch(`${baseUrl}/v1/stream/${streamId}/unsubscribe`, {
        method: "POST",
        headers,
        body,
      });
    },
  };
}
