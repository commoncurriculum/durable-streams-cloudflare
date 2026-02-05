import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState, useCallback } from "react";
import {
  ArrowLeft,
  Clock,
  Calendar,
  Radio,
  Users,
  Loader2,
  ChevronRight,
  Plus,
  X,
} from "lucide-react";
import {
  getSession,
  subscribe,
  unsubscribe,
} from "../lib/admin-api";
import type { SessionDetail } from "../lib/admin-api";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Input } from "../components/ui/input";
import { LiveMessagesPanel } from "../components/LiveMessagesPanel";
import { cn } from "../lib/utils";

export const Route = createFileRoute("/subscriptions/$sessionId")({
  component: SubscriptionSessionDetailPage,
});

function SubscriptionSessionDetailPage() {
  const { sessionId } = Route.useParams();
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Subscribe form state
  const [newStreamId, setNewStreamId] = useState("");
  const [isSubscribing, setIsSubscribing] = useState(false);
  const [unsubscribingStream, setUnsubscribingStream] = useState<string | null>(null);

  const fetchSession = useCallback(async () => {
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
  }, [sessionId]);

  useEffect(() => {
    void fetchSession();
  }, [fetchSession]);

  const handleSubscribe = async () => {
    if (!newStreamId.trim()) {
      setError("Please enter a stream ID");
      return;
    }

    try {
      setError(null);
      setSuccess(null);
      setIsSubscribing(true);
      await subscribe(sessionId, newStreamId.trim());
      setSuccess(`Subscribed to ${newStreamId}`);
      setNewStreamId("");
      await fetchSession();
    } catch (err) {
      const e = err as Error;
      setError(`Failed to subscribe: ${e.message}`);
    } finally {
      setIsSubscribing(false);
    }
  };

  const handleUnsubscribe = async (streamId: string) => {
    try {
      setError(null);
      setSuccess(null);
      setUnsubscribingStream(streamId);
      await unsubscribe(sessionId, streamId);
      setSuccess(`Unsubscribed from ${streamId}`);
      await fetchSession();
    } catch (err) {
      const e = err as Error;
      setError(`Failed to unsubscribe: ${e.message}`);
    } finally {
      setUnsubscribingStream(null);
    }
  };

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

  const clearMessages = () => {
    setError(null);
    setSuccess(null);
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-surface-400 mr-3" />
        <span className="text-surface-500">Loading session...</span>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="flex-1 overflow-auto">
        <div className="p-6 md:p-8 max-w-4xl mx-auto">
          <Card className="border-error-200 bg-error-50">
            <CardContent className="py-8 text-center">
              <p className="text-error-600 mb-4">{error || "Session not found"}</p>
              <Link to="/subscriptions">
                <Button variant="secondary">
                  <ArrowLeft className="w-4 h-4" />
                  Back to subscriptions
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
        {/* Status messages */}
        {error && (
          <div className="px-4 py-3 bg-error-500/10 border border-error-500/20 rounded-lg text-error-600 text-sm flex items-center justify-between">
            <span>
              <span className="font-medium">Error:</span> {error}
            </span>
            <button
              className="text-error-500 hover:text-error-600"
              onClick={clearMessages}
            >
              Dismiss
            </button>
          </div>
        )}
        {success && (
          <div className="px-4 py-3 bg-success-500/10 border border-success-500/20 rounded-lg text-success-600 text-sm flex items-center justify-between">
            <span>{success}</span>
            <button
              className="text-success-500 hover:text-success-600"
              onClick={clearMessages}
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Back link */}
        <Link
          to="/subscriptions"
          className="inline-flex items-center gap-2 text-sm text-surface-500 hover:text-surface-700 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to subscriptions
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
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Radio className="w-4 h-4 text-surface-500" />
              Subscribed Streams
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {session.subscribedStreams && session.subscribedStreams.length > 0 ? (
              <div className="divide-y divide-surface-100">
                {session.subscribedStreams.map((streamId) => (
                  <div
                    key={streamId}
                    className="flex items-center justify-between px-5 py-3 hover:bg-surface-50 transition-colors group"
                  >
                    <Link
                      to="/streams/$streamId"
                      params={{ streamId }}
                      className="flex-1 font-mono text-sm text-surface-700 hover:text-primary-600"
                    >
                      {decodeURIComponent(streamId)}
                    </Link>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => handleUnsubscribe(streamId)}
                        disabled={unsubscribingStream === streamId}
                        className="opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        {unsubscribingStream === streamId ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          <X className="w-3 h-3" />
                        )}
                        Unsubscribe
                      </Button>
                      <Link
                        to="/streams/$streamId"
                        params={{ streamId }}
                      >
                        <ChevronRight className="w-4 h-4 text-surface-400 group-hover:text-surface-600" />
                      </Link>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="py-8 text-center">
                <Radio className="w-10 h-10 mx-auto text-surface-300 mb-3" />
                <p className="text-surface-500">
                  This session has no subscriptions yet.
                </p>
              </div>
            )}

            {/* Subscribe form */}
            <div className="px-5 py-4 border-t border-surface-100 bg-surface-50/50">
              <div className="flex gap-2">
                <Input
                  placeholder="Stream ID (e.g., lesson:1)"
                  value={newStreamId}
                  onChange={(e) => setNewStreamId(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void handleSubscribe()}
                  className="flex-1"
                />
                <Button
                  onClick={handleSubscribe}
                  disabled={isSubscribing || !newStreamId.trim()}
                >
                  {isSubscribing ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Plus className="w-4 h-4" />
                  )}
                  Subscribe
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Live Messages Panel */}
        <LiveMessagesPanel sessionId={sessionId} />
      </div>
    </div>
  );
}
