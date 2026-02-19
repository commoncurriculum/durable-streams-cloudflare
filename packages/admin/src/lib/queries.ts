import { useQuery, keepPreviousData } from "@tanstack/react-query";
import {
  getStats,
  getEstuaries,
  getStreams,
  getHotStreams,
  getTimeseries,
  getErrors,
  inspectEstuary,
  inspectStreamSubscribers,
  getProjects,
  getProjectsWithConfig,
  getProjectStreams,
  getStreamMeta,
  getStreamTimeseries,
  getCoreStreamUrl,
  mintStreamToken,
  listProjectEstuaries,
} from "./analytics";

export function useStats() {
  return useQuery({
    queryKey: ["stats"],
    queryFn: () => getStats(),
    refetchInterval: 5000,
    placeholderData: keepPreviousData,
  });
}

export function useEstuaries() {
  return useQuery({
    queryKey: ["estuaries"],
    queryFn: () => getEstuaries(),
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

export function useEstuaryInspect(estuaryId: string | undefined, projectId: string | undefined) {
  return useQuery({
    queryKey: ["estuary", projectId, estuaryId],
    queryFn: () => inspectEstuary({ data: { estuaryId: estuaryId!, projectId: projectId! } }),
    enabled: !!estuaryId && !!projectId,
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

export function useStreamMeta(projectId: string | undefined, streamId: string | undefined) {
  return useQuery({
    queryKey: ["streamMeta", projectId, streamId],
    queryFn: () => getStreamMeta({ data: { projectId: projectId!, streamId: streamId! } }),
    enabled: !!projectId && !!streamId,
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

const FOUR_MINUTES = 4 * 60 * 1000;

export function useCoreUrl() {
  return useQuery({
    queryKey: ["coreUrl"],
    queryFn: () => getCoreStreamUrl(),
    staleTime: Infinity,
  });
}

export function useStreamToken(projectId: string | undefined) {
  return useQuery({
    queryKey: ["streamToken", projectId],
    queryFn: () => mintStreamToken({ data: { projectId: projectId! } }),
    enabled: !!projectId,
    staleTime: FOUR_MINUTES,
    refetchInterval: FOUR_MINUTES,
  });
}

export function useProjectEstuaries(projectId: string) {
  return useQuery({
    queryKey: ["projectEstuaries", projectId],
    queryFn: () => listProjectEstuaries({ data: projectId }),
    refetchInterval: 5000,
    placeholderData: keepPreviousData,
  });
}
