import { useMemo } from "react";
import { cn } from "../../lib/utils";

interface SparklineProps {
  data: number[];
  width?: number;
  height?: number;
  strokeWidth?: number;
  className?: string;
  color?: string;
  fillOpacity?: number;
}

export function Sparkline({
  data,
  width = 120,
  height = 32,
  strokeWidth = 1.5,
  className,
  color = "currentColor",
  fillOpacity = 0.1,
}: SparklineProps) {
  const path = useMemo(() => {
    if (data.length === 0) return "";

    const max = Math.max(...data, 1);
    const min = Math.min(...data, 0);
    const range = max - min || 1;
    const padding = 2;
    const effectiveWidth = width - padding * 2;
    const effectiveHeight = height - padding * 2;

    const points = data.map((value, index) => {
      const x = padding + (index / (data.length - 1 || 1)) * effectiveWidth;
      const y = padding + effectiveHeight - ((value - min) / range) * effectiveHeight;
      return { x, y };
    });

    if (points.length === 0) return "";
    if (points.length === 1) {
      return `M ${points[0].x} ${points[0].y} L ${points[0].x} ${points[0].y}`;
    }

    return points.map((p, i) => (i === 0 ? `M ${p.x} ${p.y}` : `L ${p.x} ${p.y}`)).join(" ");
  }, [data, width, height]);

  const fillPath = useMemo(() => {
    if (data.length === 0 || !path) return "";

    const max = Math.max(...data, 1);
    const min = Math.min(...data, 0);
    const range = max - min || 1;
    const padding = 2;
    const effectiveWidth = width - padding * 2;
    const effectiveHeight = height - padding * 2;

    const points = data.map((value, index) => {
      const x = padding + (index / (data.length - 1 || 1)) * effectiveWidth;
      const y = padding + effectiveHeight - ((value - min) / range) * effectiveHeight;
      return { x, y };
    });

    const firstX = points[0]?.x ?? padding;
    const lastX = points[points.length - 1]?.x ?? padding + effectiveWidth;
    const bottomY = padding + effectiveHeight;

    return `${path} L ${lastX} ${bottomY} L ${firstX} ${bottomY} Z`;
  }, [data, path, width, height]);

  if (data.length === 0) {
    return (
      <div
        className={cn("flex items-center justify-center text-surface-400 text-xs", className)}
        style={{ width, height }}
      >
        No data
      </div>
    );
  }

  return (
    <svg
      width={width}
      height={height}
      className={className}
      viewBox={`0 0 ${width} ${height}`}
    >
      {fillPath && (
        <path
          d={fillPath}
          fill={color}
          fillOpacity={fillOpacity}
        />
      )}
      <path
        d={path}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
