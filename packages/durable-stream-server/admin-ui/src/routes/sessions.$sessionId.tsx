import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  ArrowLeft,
  Clock,
  Calendar,
  Radio,
  Users,
  Loader2,
  ChevronRight,
} from "lucide-react";
import { getSession } from "../lib/admin-api";
import type { SessionDetail } from "../lib/admin-api";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { cn } from "../lib/utils";

export const Route = createFileRoute("/sessions/$sessionId")({
  component: SessionDetailPage,
});

function SessionDetailPage() {
  const { sessionId } = Route.useParams();
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchSession = async () => {
      try {
        setLoading(true);
        const data = await getSession(sessionId);
        setSession(data);
      } catch (err) {
        const e = err as Error;
        setError(e.message);
      } finally {
        setLoading(false);
      }
    };
    void fetchSession();
  }, [sessionId]);

  const formatDate = (timestamp: number): string => {
    return new Date(timestamp).toLocaleString();
  };

  const formatRelativeTime = (timestamp: number): string => {
    const now = Date.now();
    const diff = timestamp - now;
    if (diff < 0) return "Expired";
    const minutes = Math.floor(diff / 60000);
    if (minutes < 60) return `in ${minutes} minutes`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `in ${hours} hours`;
    const days = Math.floor(hours / 24);
    return `in ${days} days`;
  };

  const isExpired = (timestamp: number): boolean => {
    return timestamp < Date.now();
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-surface-400 mr-3" />
        <span className="text-surface-500">Loading session...</span>
      </div>
    );
  }

  if (error || !session) {
    return (
      <div className="flex-1 overflow-auto">
        <div className="p-6 md:p-8 max-w-4xl mx-auto">
          <Card className="border-error-200 bg-error-50">
            <CardContent className="py-8 text-center">
              <p className="text-error-600 mb-4">{error || "Session not found"}</p>
              <Link to="/sessions">
                <Button variant="secondary">
                  <ArrowLeft className="w-4 h-4" />
                  Back to sessions
                </Button>
              </Link>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto">
      <div className="p-6 md:p-8 max-w-4xl mx-auto space-y-6">
        {/* Back link */}
        <Link
          to="/sessions"
          className="inline-flex items-center gap-2 text-sm text-surface-500 hover:text-surface-700 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to sessions
        </Link>

        {/* Header */}
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-surface-900">
              Session Details
            </h1>
            <p className="font-mono text-sm text-surface-500 mt-1 break-all">
              {session.sessionId}
            </p>
          </div>
          <Badge
            variant={isExpired(session.expiresAt) ? "error" : "success"}
            className="shrink-0"
          >
            {isExpired(session.expiresAt) ? "Expired" : "Active"}
          </Badge>
        </div>

        {/* Info cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-surface-100 rounded-lg">
                  <Calendar className="w-4 h-4 text-surface-600" />
                </div>
                <div>
                  <p className="text-xs text-surface-500">Created</p>
                  <p className="font-medium text-surface-900">
                    {formatDate(session.createdAt)}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div
                  className={cn(
                    "p-2 rounded-lg",
                    isExpired(session.expiresAt)
                      ? "bg-error-100"
                      : "bg-surface-100"
                  )}
                >
                  <Clock
                    className={cn(
                      "w-4 h-4",
                      isExpired(session.expiresAt)
                        ? "text-error-600"
                        : "text-surface-600"
                    )}
                  />
                </div>
                <div>
                  <p className="text-xs text-surface-500">Expires</p>
                  <p
                    className={cn(
                      "font-medium",
                      isExpired(session.expiresAt)
                        ? "text-error-600"
                        : "text-surface-900"
                    )}
                  >
                    {formatRelativeTime(session.expiresAt)}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-primary-50 rounded-lg">
                  <Users className="w-4 h-4 text-primary-600" />
                </div>
                <div>
                  <p className="text-xs text-surface-500">Subscriptions</p>
                  <p className="font-medium text-surface-900">
                    {session.subscriptionCount}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Subscribed streams */}
        {session.subscribedStreams && session.subscribedStreams.length > 0 ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Radio className="w-4 h-4 text-surface-500" />
                Subscribed Streams
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="divide-y divide-surface-100">
                {session.subscribedStreams.map((streamId) => (
                  <Link
                    key={streamId}
                    to="/streams/$streamId"
                    params={{ streamId }}
                    className="flex items-center justify-between px-5 py-3 hover:bg-surface-50 transition-colors group"
                  >
                    <span className="font-mono text-sm text-surface-700">
                      {decodeURIComponent(streamId)}
                    </span>
                    <ChevronRight className="w-4 h-4 text-surface-400 group-hover:text-surface-600" />
                  </Link>
                ))}
              </div>
            </CardContent>
          </Card>
        ) : (
          <Card className="border-dashed">
            <CardContent className="py-8 text-center">
              <Radio className="w-10 h-10 mx-auto text-surface-300 mb-3" />
              <p className="text-surface-500">
                This session has no active subscriptions.
              </p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
