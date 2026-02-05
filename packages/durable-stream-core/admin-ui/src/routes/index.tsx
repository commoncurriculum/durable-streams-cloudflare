import { createFileRoute, Link } from "@tanstack/react-router";
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
  TrendingUp,
  Zap,
  Clock,
  Layers,
} from "lucide-react";
import { getHealth, listSessions, getHotStreams, getSystemMetrics, getQueueLatency } from "../lib/admin-api";
import type { HealthResponse, HotStream, SystemMetrics, QueueLatencyMetrics } from "../lib/admin-api";
import { useStreamDB } from "../lib/stream-db-context";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { cn, formatBytes } from "../lib/utils";

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
  const [hotStreams, setHotStreams] = useState<HotStream[]>([]);
  const [systemMetrics, setSystemMetrics] = useState<SystemMetrics | null>(null);
  const [queueLatency, setQueueLatency] = useState<QueueLatencyMetrics | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const { data: streams = [] } = useLiveQuery((q) =>
    q.from({ streams: registryDB.collections.streams })
  );

  const fetchData = async (showRefresh = false) => {
    try {
      if (showRefresh) setIsRefreshing(true);
      const [healthData, sessionsData, hotStreamsData, systemData, queueData] = await Promise.all([
        getHealth().catch(() => null),
        listSessions({ limit: 1000 }).catch(() => null),
        getHotStreams({ minutes: 5, limit: 5 }).catch(() => null),
        getSystemMetrics().catch(() => null),
        getQueueLatency({ minutes: 60 }).catch(() => null),
      ]);
      if (healthData) setHealth(healthData);
      if (sessionsData) setSessionCount(sessionsData.sessions.length);
      if (hotStreamsData) setHotStreams(hotStreamsData.streams);
      if (systemData) setSystemMetrics(systemData);
      if (queueData) setQueueLatency(queueData);
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
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
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
            label="Messages/sec"
            value={systemMetrics?.messagesPerSecond ?? "—"}
            icon={Zap}
            trend={systemMetrics ? `${systemMetrics.messagesLast5Min} in last 5 min` : undefined}
            color="primary"
          />
          <StatCard
            label="Subscribers"
            value={systemMetrics?.activeSubscribers ?? "—"}
            icon={TrendingUp}
            color="muted"
          />
        </div>

        {/* Hot Streams */}
        {hotStreams.length > 0 && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <TrendingUp className="w-4 h-4 text-surface-500" />
                Hot Streams
                <Badge variant="secondary" className="ml-auto text-xs">
                  Last 5 min
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {hotStreams.map((stream, index) => (
                <Link
                  key={stream.streamId}
                  to="/streams/$streamId"
                  params={{ streamId: stream.streamId }}
                  className={cn(
                    "flex items-center justify-between p-3 rounded-lg transition-colors",
                    "bg-surface-50 hover:bg-surface-100"
                  )}
                >
                  <div className="flex items-center gap-3">
                    <div className="flex items-center justify-center w-6 h-6 rounded-full bg-primary-100 text-primary-600 text-xs font-semibold">
                      {index + 1}
                    </div>
                    <span className="font-medium text-surface-900 truncate max-w-[200px]">
                      {decodeURIComponent(stream.streamId)}
                    </span>
                  </div>
                  <div className="flex items-center gap-4 text-sm">
                    <span className="text-surface-600 tabular-nums">
                      {stream.messageCount} msgs
                    </span>
                    <span className="text-surface-500 tabular-nums">
                      {formatBytes(stream.byteCount)}
                    </span>
                  </div>
                </Link>
              ))}
            </CardContent>
          </Card>
        )}

        {/* Queue Latency */}
        {queueLatency && queueLatency.totalMessages > 0 && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Layers className="w-4 h-4 text-surface-500" />
                Queue Latency
                <Badge variant="secondary" className="ml-auto text-xs">
                  Last {queueLatency.periodMinutes} min
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
                <div className="p-3 bg-surface-50 rounded-lg">
                  <div className="flex items-center gap-2 text-surface-500 text-xs mb-1">
                    <Clock className="w-3 h-3" />
                    Avg Lag
                  </div>
                  <div className="text-xl font-semibold text-surface-900 tabular-nums">
                    {queueLatency.avgLagTime}ms
                  </div>
                </div>
                <div className="p-3 bg-surface-50 rounded-lg">
                  <div className="text-surface-500 text-xs mb-1">P50</div>
                  <div className="text-xl font-semibold text-surface-900 tabular-nums">
                    {queueLatency.p50LagTime}ms
                  </div>
                </div>
                <div className="p-3 bg-surface-50 rounded-lg">
                  <div className="text-surface-500 text-xs mb-1">P90</div>
                  <div className="text-xl font-semibold text-surface-900 tabular-nums">
                    {queueLatency.p90LagTime}ms
                  </div>
                </div>
                <div className="p-3 bg-surface-50 rounded-lg">
                  <div className="text-surface-500 text-xs mb-1">P99</div>
                  <div className="text-xl font-semibold text-surface-900 tabular-nums">
                    {queueLatency.p99LagTime}ms
                  </div>
                </div>
              </div>
              {queueLatency.buckets.length > 0 && (
                <div className="h-16 flex items-end gap-0.5">
                  {queueLatency.buckets.slice(-60).map((bucket, i) => {
                    const maxLag = Math.max(...queueLatency.buckets.slice(-60).map(b => b.avgLagTime), 1);
                    const height = (bucket.avgLagTime / maxLag) * 100;
                    return (
                      <div
                        key={i}
                        className="flex-1 bg-primary-200 hover:bg-primary-300 transition-colors rounded-t"
                        style={{ height: `${Math.max(height, 2)}%` }}
                        title={`${bucket.minute}: ${bucket.avgLagTime}ms avg, ${bucket.messageCount} msgs`}
                      />
                    );
                  })}
                </div>
              )}
              <div className="mt-2 text-xs text-surface-500 text-center">
                {queueLatency.totalMessages.toLocaleString()} messages processed
              </div>
            </CardContent>
          </Card>
        )}

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
