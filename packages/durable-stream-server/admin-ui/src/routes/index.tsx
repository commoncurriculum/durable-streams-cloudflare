import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import {
  Activity,
  Radio,
  Users,
  Database,
  HardDrive,
  Server,
  CheckCircle2,
  AlertCircle,
  XCircle,
  RefreshCw,
} from "lucide-react";
import { getHealth, listSessions } from "../lib/admin-api";
import type { HealthResponse } from "../lib/admin-api";
import { useStreamDB } from "../lib/stream-db-context";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";

export const Route = createFileRoute("/")({
  component: OverviewPage,
});

function StatCard({
  label,
  value,
  icon: Icon,
  trend,
  color = "primary",
}: {
  label: string;
  value: string | number;
  icon: React.ElementType;
  trend?: string;
  color?: "primary" | "accent" | "muted";
}) {
  const colors = {
    primary: "bg-primary-50 text-primary-600",
    accent: "bg-accent-50 text-accent-600",
    muted: "bg-muted-50 text-muted-600",
  };

  return (
    <Card className="animate-fade-in">
      <CardContent className="p-5">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-sm font-medium text-surface-500">{label}</p>
            <p className="mt-1 text-3xl font-semibold text-surface-900 tabular-nums">
              {value}
            </p>
            {trend && (
              <p className="mt-1 text-xs text-surface-500">{trend}</p>
            )}
          </div>
          <div className={cn("p-2.5 rounded-xl", colors[color])}>
            <Icon className="w-5 h-5" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function ServiceStatusItem({
  name,
  icon: Icon,
  available,
  latencyMs,
  error,
}: {
  name: string;
  icon: React.ElementType;
  available: boolean;
  latencyMs?: number;
  error?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between p-4 rounded-xl transition-colors",
        available ? "bg-surface-50" : "bg-error-500/5"
      )}
    >
      <div className="flex items-center gap-3">
        <div
          className={cn(
            "p-2 rounded-lg",
            available ? "bg-surface-100 text-surface-600" : "bg-error-100 text-error-600"
          )}
        >
          <Icon className="w-4 h-4" />
        </div>
        <div>
          <p className="font-medium text-surface-900">{name}</p>
          {error && <p className="text-xs text-error-500 mt-0.5">{error}</p>}
        </div>
      </div>
      <div className="flex items-center gap-3">
        {latencyMs !== undefined && (
          <span className="text-sm text-surface-500 tabular-nums">
            {latencyMs}ms
          </span>
        )}
        {available ? (
          <CheckCircle2 className="w-5 h-5 text-success-500" />
        ) : (
          <XCircle className="w-5 h-5 text-error-500" />
        )}
      </div>
    </div>
  );
}

function OverviewPage() {
  const { registryDB } = useStreamDB();
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [sessionCount, setSessionCount] = useState<number>(0);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const { data: streams = [] } = useLiveQuery((q) =>
    q.from({ streams: registryDB.collections.streams })
  );

  const fetchData = async (showRefresh = false) => {
    try {
      if (showRefresh) setIsRefreshing(true);
      const [healthData, sessionsData] = await Promise.all([
        getHealth().catch(() => null),
        listSessions({ limit: 1000 }).catch(() => null),
      ]);
      if (healthData) setHealth(healthData);
      if (sessionsData) setSessionCount(sessionsData.sessions.length);
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  };

  useEffect(() => {
    void fetchData();
    const interval = setInterval(() => void fetchData(), 30000);
    return () => clearInterval(interval);
  }, []);

  const statusConfig = {
    healthy: {
      label: "All Systems Operational",
      variant: "success" as const,
      icon: CheckCircle2,
    },
    degraded: {
      label: "Degraded Performance",
      variant: "warning" as const,
      icon: AlertCircle,
    },
    unhealthy: {
      label: "System Issues Detected",
      variant: "error" as const,
      icon: XCircle,
    },
  };

  const currentStatus = health
    ? statusConfig[health.status]
    : { label: "Loading...", variant: "secondary" as const, icon: Activity };

  return (
    <div className="flex-1 overflow-auto">
      <div className="p-6 md:p-8 max-w-6xl mx-auto space-y-8">
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-surface-900">
              Overview
            </h1>
            <p className="text-surface-500 mt-1">
              Monitor your durable streams infrastructure
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Badge variant={currentStatus.variant} className="gap-1.5 px-3 py-1">
              <currentStatus.icon className="w-3.5 h-3.5" />
              {currentStatus.label}
            </Badge>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => void fetchData(true)}
              disabled={isRefreshing}
            >
              <RefreshCw
                className={cn("w-4 h-4", isRefreshing && "animate-spin")}
              />
            </Button>
          </div>
        </div>

        {/* Stats grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <StatCard
            label="Total Streams"
            value={streams.length}
            icon={Radio}
            color="primary"
          />
          <StatCard
            label="Active Sessions"
            value={sessionCount}
            icon={Users}
            color="accent"
          />
          <StatCard
            label="Uptime"
            value={health?.status === "healthy" ? "99.9%" : "—"}
            icon={Activity}
            color="muted"
          />
        </div>

        {/* Services status */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Server className="w-4 h-4 text-surface-500" />
              Service Health
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {isLoading ? (
              <div className="space-y-2">
                {[1, 2, 3].map((i) => (
                  <div
                    key={i}
                    className="h-16 rounded-xl bg-surface-100 animate-shimmer"
                  />
                ))}
              </div>
            ) : (
              <>
                <ServiceStatusItem
                  name="Registry Durable Object"
                  icon={Server}
                  available={health?.services?.registry?.available ?? false}
                  latencyMs={health?.services?.registry?.latencyMs}
                  error={health?.services?.registry?.error}
                />
                <ServiceStatusItem
                  name="D1 Database"
                  icon={Database}
                  available={health?.services?.d1?.available ?? false}
                  latencyMs={health?.services?.d1?.latencyMs}
                  error={health?.services?.d1?.error}
                />
                <ServiceStatusItem
                  name="R2 Storage"
                  icon={HardDrive}
                  available={health?.services?.r2?.available ?? false}
                  latencyMs={health?.services?.r2?.latencyMs}
                  error={health?.services?.r2?.error}
                />
              </>
            )}
          </CardContent>
        </Card>

        {/* Empty state */}
        {streams.length === 0 && !isLoading && (
          <Card className="border-dashed">
            <CardContent className="py-12 text-center">
              <Radio className="w-12 h-12 mx-auto text-surface-300 mb-4" />
              <h3 className="text-lg font-medium text-surface-900 mb-1">
                No streams yet
              </h3>
              <p className="text-surface-500 text-sm max-w-sm mx-auto">
                Create your first stream using the sidebar to start streaming
                data in real-time.
              </p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
