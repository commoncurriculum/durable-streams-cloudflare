import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";

// Shared timestamp context to avoid multiple intervals across components
const NowContext = createContext<number>(Date.now());

export function useNow(): number {
  return useContext(NowContext);
}

interface NowProviderProps {
  children: ReactNode;
  intervalMs?: number;
}

export function NowProvider({ children, intervalMs = 5000 }: NowProviderProps) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const interval = setInterval(() => {
      setNow(Date.now());
    }, intervalMs);
    return () => clearInterval(interval);
  }, [intervalMs]);

  return <NowContext.Provider value={now}>{children}</NowContext.Provider>;
}
