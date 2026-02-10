import { Button } from "@/components/ui/button";
import type { DrawingState } from "@/hooks/use-drawing";

const COLORS = [
  "#000000",
  "#EF4444",
  "#F59E0B",
  "#22C55E",
  "#3B82F6",
  "#8B5CF6",
  "#EC4899",
  "#FFFFFF",
];

interface ToolbarProps {
  drawing: DrawingState;
}

export function Toolbar({ drawing }: ToolbarProps) {
  return (
    <div className="flex items-center gap-3 border-b px-4 py-2">
      <div className="flex items-center gap-1.5">
        {COLORS.map((color) => (
          <button
            key={color}
            type="button"
            onClick={() => drawing.setColor(color)}
            className={`h-7 w-7 rounded-full border-2 transition-transform ${
              drawing.currentColor === color
                ? "scale-110 border-ring"
                : "border-border hover:scale-105"
            }`}
            style={{ backgroundColor: color }}
            aria-label={color === "#FFFFFF" ? "Eraser" : `Color ${color}`}
          />
        ))}
      </div>

      <div className="mx-2 h-6 w-px bg-border" />

      <label className="flex items-center gap-2 text-sm text-muted-fg">
        Size
        <input
          type="range"
          min={2}
          max={24}
          value={drawing.currentWidth}
          onChange={(e) => drawing.setWidth(Number(e.target.value))}
          className="w-24 accent-primary"
        />
        <span className="w-5 text-center text-xs tabular-nums">
          {drawing.currentWidth}
        </span>
      </label>

      <div className="mx-2 h-6 w-px bg-border" />

      <Button
        intent="danger"
        size="xs"
        onPress={() => drawing.handleClear()}
      >
        Clear
      </Button>
    </div>
  );
}
