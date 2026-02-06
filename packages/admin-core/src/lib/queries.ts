import { useQuery } from "@tanstack/react-query";
import { getStats, getStreams, getHotStreams, getTimeseries, inspectStream } from "./analytics";

export function useStats() {
  return useQuery({
    queryKey: ["stats"],
    queryFn: () => getStats(),
    refetchInterval: 5000,
  });
}

export function useStreams() {
  return useQuery({
    queryKey: ["streams"],
    queryFn: () => getStreams(),
    refetchInterval: 5000,
  });
}

export function useHotStreams() {
  return useQuery({
    queryKey: ["hotStreams"],
    queryFn: () => getHotStreams(),
    refetchInterval: 5000,
  });
}

export function useTimeseries() {
  return useQuery({
    queryKey: ["timeseries"],
    queryFn: () => getTimeseries(),
    refetchInterval: 5000,
  });
}

export function useStreamInspect(streamId: string | undefined) {
  return useQuery({
    queryKey: ["stream", streamId],
    queryFn: () => inspectStream({ data: streamId! }),
    enabled: !!streamId,
    refetchInterval: 2000,
  });
}
