import { Link, Outlet, createRootRoute } from "@tanstack/react-router";
import { useState } from "react";
import { DurableStream } from "@durable-streams/client";
import { and, eq, gt, useLiveQuery } from "@tanstack/react-db";
import {
  Activity,
  Plus,
  Trash2,
  Layers,
  Users,
  Menu,
  X,
  Radio,
} from "lucide-react";
import { StreamDBProvider, useStreamDB } from "../lib/stream-db-context";
import { usePresence } from "../hooks/usePresence";
import { NowProvider, useNow } from "../hooks/useNow";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { ScrollArea } from "../components/ui/scroll-area";
import { Badge } from "../components/ui/badge";
import { TooltipProvider } from "../components/ui/tooltip";
import { cn } from "../lib/utils";
import type { StreamMetadata } from "../lib/schemas";

const getServerUrl = () => {
  if (typeof window === "undefined") return "";
  return window.location.origin;
};

function StreamListItem({
  stream,
  onDelete,
}: {
  stream: StreamMetadata;
  onDelete: () => void;
}) {
  const { presenceDB } = useStreamDB();
  const now = useNow();
  const [isHovered, setIsHovered] = useState(false);

  const { data: viewers = [] } = useLiveQuery(
    (q) =>
      q
        .from({ presence: presenceDB.collections.presence })
        .where(({ presence }) =>
          and(
            eq(presence.streamPath, stream.path),
            gt(presence.lastSeen, now - 60000)
          )
        ),
    [stream.path, now]
  );

  const { data: typingUsers = [] } = useLiveQuery(
    (q) =>
      q
        .from({ presence: presenceDB.collections.presence })
        .where(({ presence }) =>
          and(
            eq(presence.streamPath, stream.path),
            eq(presence.isTyping, true),
            gt(presence.lastSeen, now - 60000)
          )
        ),
    [stream.path, now]
  );

  return (
    <div
      className="group relative"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <Link
        to="/streams/$streamId"
        params={{ streamId: stream.path }}
        className={cn(
          "flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all duration-200",
          "hover:bg-surface-100 group-hover:pr-10",
          "border border-transparent"
        )}
        activeProps={{
          className: cn(
            "flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all duration-200",
            "bg-primary-50 border-primary-200 hover:bg-primary-100"
          ),
        }}
      >
        <div
          className={cn(
            "flex items-center justify-center w-8 h-8 rounded-lg",
            "bg-surface-100 text-surface-500",
            "group-[.active]:bg-primary-100 group-[.active]:text-primary-600"
          )}
        >
          <Radio className="w-4 h-4" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-medium text-sm text-surface-900 truncate">
            {decodeURIComponent(stream.path)}
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-xs text-surface-500">
              {stream.contentType.split("/")[1]}
            </span>
            {viewers.length > 0 && (
              <div className="flex -space-x-1">
                {viewers.slice(0, 3).map((v) => (
                  <div
                    key={v.sessionId}
                    className="w-4 h-4 rounded-full border-2 border-white"
                    style={{ backgroundColor: v.color }}
                    title={`User ${v.userId.slice(0, 8)}`}
                  />
                ))}
                {viewers.length > 3 && (
                  <div className="w-4 h-4 rounded-full bg-surface-200 border-2 border-white flex items-center justify-center text-[8px] text-surface-600">
                    +{viewers.length - 3}
                  </div>
                )}
              </div>
            )}
            {typingUsers.length > 0 && (
              <span className="text-xs text-primary-500 animate-pulse-soft">
                typing...
              </span>
            )}
          </div>
        </div>
      </Link>
      <button
        className={cn(
          "absolute right-2 top-1/2 -translate-y-1/2",
          "p-1.5 rounded-md transition-all duration-200",
          "text-surface-400 hover:text-error-500 hover:bg-error-500/10",
          isHovered ? "opacity-100" : "opacity-0"
        )}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onDelete();
        }}
        title="Delete stream"
      >
        <Trash2 className="w-4 h-4" />
      </button>
    </div>
  );
}

function RootLayout() {
  const { registryDB } = useStreamDB();
  const [newStreamPath, setNewStreamPath] = useState("");
  const [newStreamContentType, setNewStreamContentType] =
    useState("text/plain");
  const [error, setError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isCreating, setIsCreating] = useState(false);

  usePresence();

  const { data: streams = [] } = useLiveQuery((q) =>
    q.from({ streams: registryDB.collections.streams })
  );

  const createStream = async () => {
    if (!newStreamPath.trim()) {
      setError("Stream path cannot be empty");
      return;
    }

    try {
      setError(null);
      setIsCreating(true);
      const serverUrl = getServerUrl();
      await DurableStream.create({
        url: `${serverUrl}/v1/stream/${newStreamPath}`,
        contentType: newStreamContentType,
      });
      setNewStreamPath("");
    } catch (err: unknown) {
      const error = err as Error;
      setError(`Failed to create stream: ${error.message}`);
    } finally {
      setIsCreating(false);
    }
  };

  const deleteStream = async (path: string) => {
    if (
      !window.confirm(
        `Delete stream "${decodeURIComponent(path)}"?\n\nThis action cannot be undone.`
      )
    ) {
      return;
    }

    try {
      setError(null);
      const serverUrl = getServerUrl();
      const stream = new DurableStream({ url: `${serverUrl}/v1/stream/${path}` });
      await stream.delete();
    } catch (err: unknown) {
      const error = err as Error;
      setError(`Failed to delete stream: ${error.message}`);
    }
  };

  return (
    <TooltipProvider>
      <div className="flex h-screen bg-surface-50">
        {/* Mobile menu button */}
        <button
          className={cn(
            "fixed top-4 left-4 z-50 p-2 rounded-lg md:hidden",
            "bg-white shadow-md border border-surface-200",
            "text-surface-600 hover:text-surface-900"
          )}
          onClick={() => setSidebarOpen(!sidebarOpen)}
        >
          {sidebarOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
        </button>

        {/* Sidebar */}
        <aside
          className={cn(
            "fixed inset-y-0 left-0 z-40 w-72 bg-white border-r border-surface-200",
            "transform transition-transform duration-300 ease-in-out",
            "md:relative md:translate-x-0",
            sidebarOpen ? "translate-x-0" : "-translate-x-full"
          )}
        >
          <div className="flex flex-col h-full">
            {/* Logo */}
            <div className="flex items-center gap-3 px-5 py-4 border-b border-surface-100">
              <div className="flex items-center justify-center w-9 h-9 rounded-xl bg-gradient-to-br from-primary-400 to-primary-600 text-white shadow-sm">
                <Layers className="w-5 h-5" />
              </div>
              <div>
                <h1 className="font-semibold text-surface-900">
                  Durable Streams
                </h1>
                <p className="text-xs text-surface-500">Admin Console</p>
              </div>
            </div>

            {/* Navigation */}
            <nav className="px-3 py-4 space-y-1">
              <Link
                to="/"
                className={cn(
                  "flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors",
                  "text-surface-600 hover:text-surface-900 hover:bg-surface-100"
                )}
                activeProps={{
                  className: cn(
                    "flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors",
                    "bg-primary-50 text-primary-700"
                  ),
                }}
              >
                <Activity className="w-4 h-4" />
                Overview
              </Link>
              <Link
                to="/sessions"
                className={cn(
                  "flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors",
                  "text-surface-600 hover:text-surface-900 hover:bg-surface-100"
                )}
                activeProps={{
                  className: cn(
                    "flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors",
                    "bg-primary-50 text-primary-700"
                  ),
                }}
              >
                <Users className="w-4 h-4" />
                Sessions
              </Link>
            </nav>

            {/* Streams section */}
            <div className="flex-1 flex flex-col min-h-0 px-3">
              <div className="flex items-center justify-between py-2 px-1">
                <span className="text-xs font-semibold text-surface-500 uppercase tracking-wider">
                  Streams
                </span>
                <Badge variant="secondary" className="text-xs">
                  {streams.length}
                </Badge>
              </div>

              {/* Create stream form */}
              <div className="space-y-2 pb-3">
                <Input
                  placeholder="New stream path..."
                  value={newStreamPath}
                  onChange={(e) => setNewStreamPath(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void createStream()}
                  className="text-sm"
                />
                <div className="flex gap-2">
                  <Select
                    value={newStreamContentType}
                    onValueChange={setNewStreamContentType}
                  >
                    <SelectTrigger className="flex-1 text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="text/plain">text/plain</SelectItem>
                      <SelectItem value="application/json">JSON</SelectItem>
                      <SelectItem value="application/octet-stream">
                        binary
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <Button
                    size="icon"
                    onClick={createStream}
                    disabled={isCreating}
                  >
                    <Plus className="w-4 h-4" />
                  </Button>
                </div>
              </div>

              {/* Stream list */}
              <ScrollArea className="flex-1 -mx-3">
                <div className="px-3 space-y-1">
                  {streams.map((stream) => (
                    <StreamListItem
                      key={stream.path}
                      stream={stream}
                      onDelete={() => deleteStream(stream.path)}
                    />
                  ))}
                  {streams.length === 0 && (
                    <div className="py-8 text-center">
                      <Radio className="w-8 h-8 mx-auto text-surface-300 mb-2" />
                      <p className="text-sm text-surface-500">No streams yet</p>
                      <p className="text-xs text-surface-400 mt-1">
                        Create one above to get started
                      </p>
                    </div>
                  )}
                </div>
              </ScrollArea>
            </div>
          </div>
        </aside>

        {/* Main content */}
        <main className="flex-1 flex flex-col min-h-0 overflow-hidden">
          {/* Error banner */}
          {error && (
            <div className="px-6 py-3 bg-error-500/10 border-b border-error-500/20 text-error-600 text-sm animate-slide-up">
              <span className="font-medium">Error:</span> {error}
              <button
                className="ml-4 text-error-500 hover:text-error-600"
                onClick={() => setError(null)}
              >
                Dismiss
              </button>
            </div>
          )}
          <Outlet />
        </main>

        {/* Mobile overlay */}
        {sidebarOpen && (
          <div
            className="fixed inset-0 bg-black/20 z-30 md:hidden"
            onClick={() => setSidebarOpen(false)}
          />
        )}
      </div>
    </TooltipProvider>
  );
}

function RootLayoutWithProvider() {
  return (
    <StreamDBProvider>
      <NowProvider>
        <RootLayout />
      </NowProvider>
    </StreamDBProvider>
  );
}

export const Route = createRootRoute({
  component: RootLayoutWithProvider,
});
