import { useState, useEffect, useCallback } from "react";

export interface StreamInfo {
  streamId: string;
  contentType: string;
  closed: boolean;
  createdAt: number;
  expiresAt: number | null;
}

interface StreamsResponse {
  streams: StreamInfo[];
  nextCursor?: string;
  hasMore: boolean;
}

const getServerUrl = () => {
  if (typeof window === "undefined") return "";
  return window.location.origin;
};

export function useStreams() {
  const [streams, setStreams] = useState<StreamInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchStreams = useCallback(async () => {
    try {
      const serverUrl = getServerUrl();
      const response = await fetch(`${serverUrl}/admin/streams?limit=100`);
      if (!response.ok) {
        throw new Error(`Failed to fetch streams: ${response.status}`);
      }
      const data = (await response.json()) as StreamsResponse;
      setStreams(data.streams);
      setError(null);
    } catch (err) {
      const e = err as Error;
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial fetch
  useEffect(() => {
    void fetchStreams();
  }, [fetchStreams]);

  // Poll for updates every 5 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      void fetchStreams();
    }, 5000);
    return () => clearInterval(interval);
  }, [fetchStreams]);

  return { streams, loading, error, refetch: fetchStreams };
}
