export function streamUrl(
  coreUrl: string,
  projectId: string,
  streamId: string,
): string {
  return `${coreUrl}/v1/stream/${encodeURIComponent(projectId)}/${encodeURIComponent(streamId)}`;
}
