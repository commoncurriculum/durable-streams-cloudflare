import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Users, Clock, Radio, Loader2, ChevronRight } from "lucide-react";
import { listSessions } from "../lib/admin-api";
import type { SessionInfo } from "../lib/admin-api";
import { Card, CardContent } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { cn } from "../lib/utils";

export const Route = createFileRoute("/sessions/")({
  component: SessionsPage,
});

function SessionsPage() {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [hasMore, setHasMore] = useState(false);

  const fetchSessions = async (cursor?: string) => {
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
  };

  useEffect(() => {
    void fetchSessions();
  }, []);

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

  return (
    <div className="flex-1 overflow-auto">
      <div className="p-6 md:p-8 max-w-6xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-surface-900">Sessions</h1>
            <p className="text-surface-500 mt-1">
              Active client sessions and their subscriptions
            </p>
          </div>
          <Badge variant="secondary" className="gap-1.5">
            <Users className="w-3.5 h-3.5" />
            {sessions.length} active
          </Badge>
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
              <Users className="w-12 h-12 mx-auto text-surface-300 mb-4" />
              <h3 className="text-lg font-medium text-surface-900 mb-1">
                No active sessions
              </h3>
              <p className="text-surface-500 text-sm">
                Sessions are created when clients connect to streams.
              </p>
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
                            to="/sessions/$sessionId"
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
                            to="/sessions/$sessionId"
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
      </div>
    </div>
  );
}
