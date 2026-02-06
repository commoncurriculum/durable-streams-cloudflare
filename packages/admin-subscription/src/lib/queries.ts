import { useQuery, keepPreviousData } from "@tanstack/react-query";
import {
  getStats,
  getSessions,
  getStreams,
  getHotStreams,
  getTimeseries,
  getErrors,
  inspectSession,
  inspectStreamSubscribers,
} from "./analytics";

export function useStats() {
  return useQuery({
    queryKey: ["stats"],
    queryFn: () => getStats(),
    refetchInterval: 5000,
    placeholderData: keepPreviousData,
  });
}

export function useSessions() {
  return useQuery({
    queryKey: ["sessions"],
    queryFn: () => getSessions(),
    refetchInterval: 5000,
    placeholderData: keepPreviousData,
  });
}

export function useStreams() {
  return useQuery({
    queryKey: ["streams"],
    queryFn: () => getStreams(),
    refetchInterval: 5000,
    placeholderData: keepPreviousData,
  });
}

export function useHotStreams() {
  return useQuery({
    queryKey: ["hotStreams"],
    queryFn: () => getHotStreams(),
    refetchInterval: 5000,
    placeholderData: keepPreviousData,
  });
}

export function useTimeseries() {
  return useQuery({
    queryKey: ["timeseries"],
    queryFn: () => getTimeseries(),
    refetchInterval: 5000,
    placeholderData: keepPreviousData,
  });
}

export function useErrors() {
  return useQuery({
    queryKey: ["errors"],
    queryFn: () => getErrors(),
    refetchInterval: 10000,
    placeholderData: keepPreviousData,
  });
}

export function useSessionInspect(sessionId: string | undefined) {
  return useQuery({
    queryKey: ["session", sessionId],
    queryFn: () => inspectSession({ data: sessionId! }),
    enabled: !!sessionId,
    refetchInterval: 2000,
    placeholderData: keepPreviousData,
  });
}

export function useStreamSubscribers(streamId: string | undefined) {
  return useQuery({
    queryKey: ["streamSubscribers", streamId],
    queryFn: () => inspectStreamSubscribers({ data: streamId! }),
    enabled: !!streamId,
    refetchInterval: 5000,
    placeholderData: keepPreviousData,
  });
}
