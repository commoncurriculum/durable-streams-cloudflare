import { useState, useRef, useCallback, useEffect } from "react";
import getStroke from "perfect-freehand";
import type { DrawMessage, StrokeMessage } from "@/lib/stream";

const STROKE_OPTIONS = {
  size: 8,
  thinning: 0.5,
  smoothing: 0.5,
  streamline: 0.5,
};

function getSvgPathFromStroke(stroke: number[][]): string {
  if (stroke.length === 0) return "";

  const d = stroke.reduce(
    (acc, [x0, y0], i, arr) => {
      const [x1, y1] = arr[(i + 1) % arr.length];
      acc.push(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
      return acc;
    },
    ["M", ...stroke[0], "Q"],
  );

  d.push("Z");
  return d.join(" ");
}

export interface DrawingState {
  strokes: StrokeMessage[];
  currentColor: string;
  currentWidth: number;
  setColor: (color: string) => void;
  setWidth: (width: number) => void;
  committedCanvasRef: React.RefObject<HTMLCanvasElement | null>;
  activeCanvasRef: React.RefObject<HTMLCanvasElement | null>;
  handlePointerDown: (e: React.PointerEvent) => void;
  handlePointerMove: (e: React.PointerEvent) => void;
  handlePointerUp: (e: React.PointerEvent) => void;
  handleClear: () => void;
  renderRemoteMessage: (msg: DrawMessage) => void;
  redrawAll: () => void;
}

export function useDrawing(
  userId: string,
  onStrokeEnd: (msg: StrokeMessage) => void,
  onClear: () => void,
): DrawingState {
  const [currentColor, setColor] = useState("#000000");
  const [currentWidth, setWidth] = useState(8);
  const strokesRef = useRef<StrokeMessage[]>([]);
  const [strokes, setStrokes] = useState<StrokeMessage[]>([]);
  const currentPointsRef = useRef<[number, number, number][]>([]);
  const isDrawingRef = useRef(false);
  const committedCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const activeCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const renderStroke = useCallback(
    (
      ctx: CanvasRenderingContext2D,
      points: [number, number, number][],
      color: string,
      width: number,
    ) => {
      const stroke = getStroke(points, { ...STROKE_OPTIONS, size: width });
      const pathStr = getSvgPathFromStroke(stroke);
      if (!pathStr) return;
      const path = new Path2D(pathStr);
      ctx.fillStyle = color;
      ctx.fill(path);
    },
    [],
  );

  const redrawCommitted = useCallback(() => {
    const canvas = committedCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const s of strokesRef.current) {
      renderStroke(ctx, s.points, s.color, s.width);
    }
  }, [renderStroke]);

  const redrawAll = useCallback(() => {
    redrawCommitted();
  }, [redrawCommitted]);

  const renderRemoteMessage = useCallback(
    (msg: DrawMessage) => {
      if (msg.type === "clear") {
        strokesRef.current = [];
        setStrokes([]);
        const canvas = committedCanvasRef.current;
        if (canvas) {
          const ctx = canvas.getContext("2d");
          if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
        }
        return;
      }

      strokesRef.current.push(msg);
      setStrokes([...strokesRef.current]);
      const canvas = committedCanvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      renderStroke(ctx, msg.points, msg.color, msg.width);
    },
    [renderStroke],
  );

  const clearActiveCanvas = useCallback(() => {
    const canvas = activeCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
  }, []);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      isDrawingRef.current = true;
      currentPointsRef.current = [[e.nativeEvent.offsetX, e.nativeEvent.offsetY, e.pressure]];

      // Draw initial point on active canvas
      const canvas = activeCanvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      clearActiveCanvas();
      renderStroke(ctx, currentPointsRef.current, currentColor, currentWidth);
    },
    [currentColor, currentWidth, renderStroke, clearActiveCanvas],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!isDrawingRef.current) return;
      e.preventDefault();
      currentPointsRef.current.push([e.nativeEvent.offsetX, e.nativeEvent.offsetY, e.pressure]);

      // Redraw active stroke
      const canvas = activeCanvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      clearActiveCanvas();
      renderStroke(ctx, currentPointsRef.current, currentColor, currentWidth);
    },
    [currentColor, currentWidth, renderStroke, clearActiveCanvas],
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (!isDrawingRef.current) return;
      e.preventDefault();
      isDrawingRef.current = false;

      const points = currentPointsRef.current;
      if (points.length === 0) return;

      const msg: StrokeMessage = {
        type: "stroke",
        userId,
        points,
        color: currentColor,
        width: currentWidth,
      };

      // Move from active to committed canvas
      strokesRef.current.push(msg);
      setStrokes([...strokesRef.current]);
      const canvas = committedCanvasRef.current;
      if (canvas) {
        const ctx = canvas.getContext("2d");
        if (ctx) renderStroke(ctx, points, currentColor, currentWidth);
      }
      clearActiveCanvas();
      currentPointsRef.current = [];

      onStrokeEnd(msg);
    },
    [userId, currentColor, currentWidth, renderStroke, clearActiveCanvas, onStrokeEnd],
  );

  const handleClear = useCallback(() => {
    strokesRef.current = [];
    setStrokes([]);
    const committed = committedCanvasRef.current;
    if (committed) {
      const ctx = committed.getContext("2d");
      if (ctx) ctx.clearRect(0, 0, committed.width, committed.height);
    }
    clearActiveCanvas();
    onClear();
  }, [clearActiveCanvas, onClear]);

  // Sync canvas size on mount
  useEffect(() => {
    const handleResize = () => {
      for (const ref of [committedCanvasRef, activeCanvasRef]) {
        const canvas = ref.current;
        if (!canvas) continue;
        const parent = canvas.parentElement;
        if (!parent) continue;
        canvas.width = parent.clientWidth;
        canvas.height = parent.clientHeight;
      }
      redrawCommitted();
    };

    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [redrawCommitted]);

  return {
    strokes,
    currentColor,
    currentWidth,
    setColor,
    setWidth,
    committedCanvasRef,
    activeCanvasRef,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    handleClear,
    renderRemoteMessage,
    redrawAll,
  };
}
