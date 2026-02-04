import { useEffect, useState, useCallback } from "react";
import { getHotStreams, type HotStream } from "../lib/admin-api";

/**
 * Hook to fetch and track hot streams for activity indicators
 */
export function useHotStreams(options?: { minutes?: number; limit?: number }) {
  const { minutes = 5, limit = 50 } = options || {};
  const [hotStreams, setHotStreams] = useState<Map<string, HotStream>>(new Map());
  const [isLoading, setIsLoading] = useState(true);

  const fetchHotStreams = useCallback(async () => {
    try {
      const data = await getHotStreams({ minutes, limit });
      const map = new Map<string, HotStream>();
      for (const stream of data.streams) {
        map.set(stream.streamId, stream);
      }
      setHotStreams(map);
    } catch {
      // Ignore errors - metrics may not be configured
    } finally {
      setIsLoading(false);
    }
  }, [minutes, limit]);

  useEffect(() => {
    void fetchHotStreams();
    const interval = setInterval(fetchHotStreams, 30000);
    return () => clearInterval(interval);
  }, [fetchHotStreams]);

  const isHot = useCallback(
    (streamId: string) => hotStreams.has(streamId),
    [hotStreams]
  );

  const getStreamMetrics = useCallback(
    (streamId: string) => hotStreams.get(streamId),
    [hotStreams]
  );

  return { hotStreams, isHot, getStreamMetrics, isLoading, refresh: fetchHotStreams };
}
