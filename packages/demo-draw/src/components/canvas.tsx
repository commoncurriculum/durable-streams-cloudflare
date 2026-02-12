import type { DrawingState } from "@/hooks/use-drawing";

interface CanvasProps {
  drawing: DrawingState;
}

export function Canvas({ drawing }: CanvasProps) {
  return (
    <div className="relative flex-1 overflow-hidden">
      <canvas ref={drawing.committedCanvasRef} className="absolute inset-0 h-full w-full" />
      <canvas
        ref={drawing.activeCanvasRef}
        className="absolute inset-0 h-full w-full"
        style={{ touchAction: "none" }}
        onPointerDown={drawing.handlePointerDown}
        onPointerMove={drawing.handlePointerMove}
        onPointerUp={drawing.handlePointerUp}
        onPointerLeave={drawing.handlePointerUp}
      />
    </div>
  );
}
