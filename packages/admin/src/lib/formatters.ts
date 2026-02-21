export function formatBytes(b: number): string {
  if (b === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(Math.abs(b)) / Math.log(1024));
  const idx = Math.min(i, units.length - 1);
  return (b / Math.pow(1024, idx)).toFixed(idx === 0 ? 0 : 1) + " " + units[idx];
}

export function formatRate(total: number, windowSec: number): string {
  const perMin = (total / windowSec) * 60;
  return perMin < 10 ? perMin.toFixed(1) : Math.round(perMin).toString();
}

export function relTime(ts: string | number | null | undefined): string {
  if (!ts) return "\u2014";
  const d = typeof ts === "number" ? new Date(ts) : new Date(ts);
  if (isNaN(d.getTime())) return String(ts);
  const abs = Math.abs(Date.now() - d.getTime());
  if (abs < 60000) return Math.round(abs / 1000) + "s ago";
  if (abs < 3600000) return Math.round(abs / 60000) + "m ago";
  if (abs < 86400000) return Math.round(abs / 3600000) + "h ago";
  return Math.round(abs / 86400000) + "d ago";
}
