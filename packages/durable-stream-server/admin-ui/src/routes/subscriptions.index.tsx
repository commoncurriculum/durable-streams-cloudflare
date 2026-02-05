import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState, useCallback } from "react";
import {
  Bell,
  Clock,
  Radio,
  Loader2,
  ChevronRight,
  Plus,
  Users,
} from "lucide-react";
import {
  listSessions,
  createSession,
  subscribe,
} from "../lib/admin-api";
import type { SessionInfo } from "../lib/admin-api";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Input } from "../components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { cn } from "../lib/utils";

export const Route = createFileRoute("/subscriptions/")({
  component: SubscriptionsPage,
});

function SubscriptionsPage() {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [hasMore, setHasMore] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Quick subscribe form state
  const [selectedSessionId, setSelectedSessionId] = useState<string>("");
  const [streamIdInput, setStreamIdInput] = useState("");
  const [isSubscribing, setIsSubscribing] = useState(false);

  const fetchSessions = useCallback(async (cursor?: string) => {
    try {
      setLoading(true);
      const result = await listSessions({ limit: 50, cursor });
      if (cursor) {
        setSessions((prev) => [...prev, ...result.sessions]);
      } else {
        setSessions(result.sessions);
      }
      setNextCursor(result.nextCursor);
      setHasMore(result.hasMore);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchSessions();
  }, [fetchSessions]);

  const handleCreateSession = async () => {
    try {
      setError(null);
      setSuccess(null);
      setIsCreating(true);
      const result = await createSession();
      setSuccess(`Session created: ${result.sessionId.slice(0, 16)}...`);
      setSelectedSessionId(result.sessionId);
      // Refresh list - don't fail the whole operation if this errors
      try {
        await fetchSessions();
      } catch {
        // Session was created but list refresh failed - that's ok
      }
    } catch (err) {
      const e = err as Error;
      setError(`Failed to create session: ${e.message}`);
    } finally {
      setIsCreating(false);
    }
  };

  const handleQuickSubscribe = async () => {
    if (!selectedSessionId || !streamIdInput.trim()) {
      setError("Please select a session and enter a stream ID");
      return;
    }

    try {
      setError(null);
      setSuccess(null);
      setIsSubscribing(true);
      await subscribe(selectedSessionId, streamIdInput.trim());
      setSuccess(`Subscribed to ${streamIdInput}`);
      setStreamIdInput("");
      // Refresh to update subscription counts
      await fetchSessions();
    } catch (err) {
      const e = err as Error;
      setError(`Failed to subscribe: ${e.message}`);
    } finally {
      setIsSubscribing(false);
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
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    return `${days}d`;
  };

  const isExpiringSoon = (timestamp: number): boolean => {
    const diff = timestamp - Date.now();
    return diff > 0 && diff < 3600000; // Less than 1 hour
  };

  const clearMessages = () => {
    setError(null);
    setSuccess(null);
  };

  return (
    <div className="flex-1 overflow-auto">
      <div className="p-6 md:p-8 max-w-6xl mx-auto space-y-6">
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

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-surface-900">
              Subscriptions
            </h1>
            <p className="text-surface-500 mt-1">
              Manage sessions and stream subscriptions
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Badge variant="secondary" className="gap-1.5">
              <Users className="w-3.5 h-3.5" />
              {sessions.length} sessions
            </Badge>
            <Button onClick={handleCreateSession} disabled={isCreating}>
              {isCreating ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Plus className="w-4 h-4" />
              )}
              Create Session
            </Button>
          </div>
        </div>

        {/* Sessions list */}
        {loading && sessions.length === 0 ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="w-6 h-6 animate-spin text-surface-400 mr-3" />
            <span className="text-surface-500">Loading sessions...</span>
          </div>
        ) : sessions.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="py-12 text-center">
              <Bell className="w-12 h-12 mx-auto text-surface-300 mb-4" />
              <h3 className="text-lg font-medium text-surface-900 mb-1">
                No sessions yet
              </h3>
              <p className="text-surface-500 text-sm mb-4">
                Create a session to start subscribing to streams.
              </p>
              <Button onClick={handleCreateSession} disabled={isCreating}>
                {isCreating ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Plus className="w-4 h-4" />
                )}
                Create Session
              </Button>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-surface-100">
                      <th className="px-4 py-3 text-left text-xs font-medium text-surface-500 uppercase tracking-wider">
                        Session ID
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-surface-500 uppercase tracking-wider">
                        Created
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-surface-500 uppercase tracking-wider">
                        Expires
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-surface-500 uppercase tracking-wider">
                        Subscriptions
                      </th>
                      <th className="px-4 py-3 w-10"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {sessions.map((session, index) => (
                      <tr
                        key={session.sessionId}
                        className={cn(
                          "group hover:bg-surface-50 transition-colors",
                          index !== sessions.length - 1 &&
                            "border-b border-surface-50"
                        )}
                        style={{ animationDelay: `${index * 30}ms` }}
                      >
                        <td className="px-4 py-3">
                          <Link
                            to="/subscriptions/$sessionId"
                            params={{ sessionId: session.sessionId }}
                            className="font-mono text-sm text-primary-600 hover:text-primary-700 hover:underline"
                          >
                            {session.sessionId.slice(0, 16)}...
                          </Link>
                        </td>
                        <td className="px-4 py-3 text-sm text-surface-600">
                          {formatDate(session.createdAt)}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <Clock
                              className={cn(
                                "w-4 h-4",
                                isExpiringSoon(session.expiresAt)
                                  ? "text-warning-500"
                                  : "text-surface-400"
                              )}
                            />
                            <span
                              className={cn(
                                "text-sm",
                                isExpiringSoon(session.expiresAt)
                                  ? "text-warning-600 font-medium"
                                  : "text-surface-600"
                              )}
                              title={formatDate(session.expiresAt)}
                            >
                              {formatRelativeTime(session.expiresAt)}
                            </span>
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <Radio className="w-4 h-4 text-surface-400" />
                            <span className="text-sm text-surface-900">
                              {session.subscriptionCount}
                            </span>
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <Link
                            to="/subscriptions/$sessionId"
                            params={{ sessionId: session.sessionId }}
                          >
                            <ChevronRight className="w-4 h-4 text-surface-400 group-hover:text-surface-600 transition-colors" />
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Load more */}
        {hasMore && (
          <div className="flex justify-center">
            <Button
              variant="secondary"
              onClick={() => void fetchSessions(nextCursor)}
              disabled={loading}
            >
              {loading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Loading...
                </>
              ) : (
                "Load more"
              )}
            </Button>
          </div>
        )}

        {/* Quick Subscribe panel */}
        {sessions.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Bell className="w-4 h-4 text-surface-500" />
                Quick Subscribe
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-col sm:flex-row gap-3">
                <Select
                  value={selectedSessionId}
                  onValueChange={setSelectedSessionId}
                >
                  <SelectTrigger className="flex-1 sm:max-w-[240px]">
                    <SelectValue placeholder="Select session..." />
                  </SelectTrigger>
                  <SelectContent>
                    {sessions.map((session) => (
                      <SelectItem key={session.sessionId} value={session.sessionId}>
                        {session.sessionId.slice(0, 16)}...
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  placeholder="Stream ID (e.g., lesson:1)"
                  value={streamIdInput}
                  onChange={(e) => setStreamIdInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void handleQuickSubscribe()}
                  className="flex-1"
                />
                <Button
                  onClick={handleQuickSubscribe}
                  disabled={isSubscribing || !selectedSessionId || !streamIdInput.trim()}
                >
                  {isSubscribing ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Plus className="w-4 h-4" />
                  )}
                  Subscribe
                </Button>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
