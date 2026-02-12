import { useQuery, keepPreviousData } from "@tanstack/react-query";
import {
  getStats,
  getStreams,
  getHotStreams,
  getTimeseries,
  getProjects,
  getProjectsWithConfig,
  getProjectStreams,
  getStreamTimeseries,
  getCoreStreamUrl,
  mintStreamToken,
} from "./analytics";

export function useStats() {
  return useQuery({
    queryKey: ["stats"],
    queryFn: () => getStats(),
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

export function useProjects() {
  return useQuery({
    queryKey: ["projects"],
    queryFn: () => getProjects(),
  });
}

export function useProjectsWithConfig() {
  return useQuery({
    queryKey: ["projectsWithConfig"],
    queryFn: () => getProjectsWithConfig(),
  });
}

export function useProjectStreams(projectId: string) {
  return useQuery({
    queryKey: ["projectStreams", projectId],
    queryFn: () => getProjectStreams({ data: projectId }),
    refetchInterval: 5000,
    placeholderData: keepPreviousData,
  });
}

export function useStreamTimeseries(doKey: string) {
  return useQuery({
    queryKey: ["streamTimeseries", doKey],
    queryFn: () => getStreamTimeseries({ data: doKey }),
    refetchInterval: 5000,
    placeholderData: keepPreviousData,
  });
}

export function useCoreUrl() {
  return useQuery({
    queryKey: ["coreUrl"],
    queryFn: () => getCoreStreamUrl(),
    staleTime: Infinity,
  });
}

const FOUR_MINUTES = 4 * 60 * 1000;

export function useStreamToken(projectId: string | undefined) {
  return useQuery({
    queryKey: ["streamToken", projectId],
    queryFn: () => mintStreamToken({ data: { projectId: projectId! } }),
    enabled: !!projectId,
    staleTime: FOUR_MINUTES,
    refetchInterval: FOUR_MINUTES,
  });
}
