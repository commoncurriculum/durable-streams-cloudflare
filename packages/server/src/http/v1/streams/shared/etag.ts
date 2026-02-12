export function buildEtag(streamId: string, start: number, end: number, closed: boolean): string {
  return `"${streamId}:${start}:${end}${closed ? ":c" : ""}"`;
}
