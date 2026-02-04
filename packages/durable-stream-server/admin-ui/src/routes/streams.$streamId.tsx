import { createFileRoute, redirect } from "@tanstack/react-router";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { DurableStream, IdempotentProducer } from "@durable-streams/client";
import { and, eq, gt, useLiveQuery } from "@tanstack/react-db";
import { useVirtualizer } from "@tanstack/react-virtual";
import ReactJson from "react-json-view";
import {
  Radio,
  Send,
  ChevronDown,
  ChevronRight,
  MessageSquare,
  Layers,
  HardDrive,
  Users,
  Loader2,
} from "lucide-react";
import { useStreamDB } from "../lib/stream-db-context";
import { useTypingIndicator } from "../hooks/useTypingIndicator";
import { useNow } from "../hooks/useNow";
import { streamStore } from "../lib/stream-store";
import { getStream, listSegments } from "../lib/admin-api";
import type { StreamDetail, SegmentInfo } from "../lib/admin-api";
import { Card, CardContent } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";
import { Badge } from "../components/ui/badge";
import { ScrollArea } from "../components/ui/scroll-area";
import { cn, formatBytes } from "../lib/utils";

const getServerUrl = () => {
  if (typeof window === "undefined") return "";
  return window.location.origin;
};

// Hoisted outside component to prevent recreation on every render
const JSON_THEME = {
  base00: "#ffffff",
  base01: "#f8f9fa",
  base02: "#e9ecef",
  base03: "#6c757d",
  base04: "#495057",
  base05: "#212529",
  base06: "#212529",
  base07: "#212529",
  base08: "#e57373",
  base09: "#ffb74d",
  base0A: "#81c784",
  base0B: "#4db6ac",
  base0C: "#4dd0e1",
  base0D: "#64b5f6",
  base0E: "#ba68c8",
  base0F: "#f06292",
};

export const Route = createFileRoute("/streams/$streamId")({
  loader: async ({ params }) => {
    try {
      const serverUrl = getServerUrl();
      const streamMetadata = new DurableStream({
        url: `${serverUrl}/v1/stream/${params.streamId}`,
      });
      const metadata = await streamMetadata.head();
      const stream = new DurableStream({
        url: `${serverUrl}/v1/stream/${params.streamId}`,
        contentType: metadata.contentType || undefined,
      });
      return {
        contentType: metadata.contentType || undefined,
        stream,
      };
    } catch {
      throw redirect({ to: "/" });
    }
  },
  component: StreamViewer,
});

function StatMini({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: string | number;
  icon: React.ElementType;
}) {
  return (
    <div className="flex items-center gap-3 p-3 bg-surface-50 rounded-lg">
      <div className="p-2 bg-white rounded-lg shadow-sm">
        <Icon className="w-4 h-4 text-surface-500" />
      </div>
      <div>
        <p className="text-xs text-surface-500">{label}</p>
        <p className="font-semibold text-surface-900 tabular-nums">{value}</p>
      </div>
    </div>
  );
}

function StreamViewer() {
  const { streamId } = Route.useParams();
  const { contentType, stream } = Route.useLoaderData();
  const { presenceDB } = useStreamDB();
  const { startTyping } = useTypingIndicator(streamId);
  const [writeInput, setWriteInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const parentRef = useRef<HTMLDivElement>(null);
  const now = useNow();

  const [streamDetail, setStreamDetail] = useState<StreamDetail | null>(null);
  const [segments, setSegments] = useState<SegmentInfo[]>([]);
  const [showSegments, setShowSegments] = useState(false);
  const [segmentsLoading, setSegmentsLoading] = useState(false);

  const producerRef = useRef<IdempotentProducer | null>(null);
  useEffect(() => {
    const producerId = `admin-ui-${crypto.randomUUID().slice(0, 8)}`;
    producerRef.current = new IdempotentProducer(stream, producerId, {
      autoClaim: true,
      lingerMs: 0,
    });
    return () => {
      producerRef.current?.close();
    };
  }, [stream]);

  useEffect(() => {
    const fetchDetail = async () => {
      try {
        const detail = await getStream(streamId);
        setStreamDetail(detail);
      } catch {
        // Ignore errors
      }
    };
    void fetchDetail();
  }, [streamId]);

  const subscribe = useCallback(
    (callback: () => void) => streamStore.subscribe(streamId, stream, callback),
    [streamId, stream]
  );

  const getSnapshot = useCallback(
    () => streamStore.getMessages(streamId),
    [streamId]
  );

  const messages = useSyncExternalStore(subscribe, getSnapshot);

  const isRegistryStream =
    streamId === "__registry__" || streamId === "__presence__";
  const isJsonStream = contentType?.includes("application/json");

  const flatItems = useMemo(() => {
    if (!isJsonStream) return [];
    return messages.flatMap((msg) => {
      try {
        const parsedMessages = JSON.parse(msg.data);
        return parsedMessages;
      } catch {
        return [];
      }
    });
  }, [messages, isJsonStream]);

  const virtualizer = useVirtualizer({
    count: flatItems.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 100,
    overscan: 5,
  });

  const { data: typers = [] } = useLiveQuery(
    (q) =>
      q
        .from({ presence: presenceDB.collections.presence })
        .where(({ presence }) =>
          and(
            eq(presence.streamPath, streamId),
            eq(presence.isTyping, true),
            gt(presence.lastSeen, now - 60000)
          )
        ),
    [streamId, now]
  );

  useEffect(() => {
    if (isJsonStream && flatItems.length > 0) {
      queueMicrotask(() => {
        virtualizer.scrollToIndex(flatItems.length - 1, { align: "end" });
      });
    } else if (!isJsonStream) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, isJsonStream, flatItems.length, virtualizer]);

  const writeToStream = async () => {
    if (!writeInput.trim() || !producerRef.current) return;
    try {
      setError(null);
      setIsSending(true);
      await producerRef.current.append(writeInput + "\n");
      setWriteInput("");
    } catch (err: unknown) {
      const e = err as Error;
      setError(`Failed to write to stream: ${e.message}`);
    } finally {
      setIsSending(false);
    }
  };

  const loadSegments = async () => {
    if (segmentsLoading) return;
    setSegmentsLoading(true);
    try {
      const result = await listSegments(streamId, { limit: 50 });
      setSegments(result.segments);
    } catch {
      // Ignore errors
    }
    setSegmentsLoading(false);
  };

  const formatDate = (timestamp: number): string => {
    return new Date(timestamp).toLocaleString();
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 bg-white border-b border-surface-200">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-primary-50 rounded-lg">
            <Radio className="w-5 h-5 text-primary-600" />
          </div>
          <div>
            <h1 className="font-semibold text-surface-900">
              {decodeURIComponent(streamId)}
            </h1>
            <p className="text-xs text-surface-500">{contentType}</p>
          </div>
        </div>
        <Badge variant="success" className="gap-1.5">
          <span className="w-1.5 h-1.5 bg-current rounded-full animate-pulse-soft" />
          Live
        </Badge>
      </div>

      {/* Error banner */}
      {error && (
        <div className="px-6 py-3 bg-error-500/10 text-error-600 text-sm">
          {error}
        </div>
      )}

      {/* Stats panel */}
      {streamDetail && (
        <div className="px-6 py-4 bg-surface-100/50 border-b border-surface-200">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatMini
              label="Messages"
              value={streamDetail.messageCount || 0}
              icon={MessageSquare}
            />
            <StatMini
              label="Segments"
              value={streamDetail.segmentCount || 0}
              icon={Layers}
            />
            <StatMini
              label="Total Size"
              value={formatBytes(streamDetail.totalBytes || 0)}
              icon={HardDrive}
            />
            <StatMini
              label="Subscribers"
              value={streamDetail.subscriberCount || 0}
              icon={Users}
            />
          </div>

          {/* Segments collapsible */}
          {(streamDetail.segmentCount || 0) > 0 && (
            <div className="mt-4">
              <button
                className={cn(
                  "flex items-center gap-2 w-full px-4 py-3 rounded-lg transition-colors",
                  "bg-white border border-surface-200 hover:bg-surface-50",
                  "text-left text-sm font-medium text-surface-700"
                )}
                onClick={() => {
                  setShowSegments(!showSegments);
                  if (!showSegments && segments.length === 0) {
                    void loadSegments();
                  }
                }}
              >
                {showSegments ? (
                  <ChevronDown className="w-4 h-4" />
                ) : (
                  <ChevronRight className="w-4 h-4" />
                )}
                Segments ({streamDetail.segmentCount})
              </button>
              {showSegments && (
                <div className="mt-2 animate-slide-up">
                  <Card>
                    <CardContent className="p-0">
                      {segmentsLoading ? (
                        <div className="flex items-center justify-center py-8 text-surface-500">
                          <Loader2 className="w-5 h-5 animate-spin mr-2" />
                          Loading segments...
                        </div>
                      ) : (
                        <div className="overflow-x-auto">
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="border-b border-surface-100">
                                <th className="px-4 py-3 text-left font-medium text-surface-500">
                                  Seq
                                </th>
                                <th className="px-4 py-3 text-left font-medium text-surface-500">
                                  Offsets
                                </th>
                                <th className="px-4 py-3 text-left font-medium text-surface-500">
                                  Messages
                                </th>
                                <th className="px-4 py-3 text-left font-medium text-surface-500">
                                  Size
                                </th>
                                <th className="px-4 py-3 text-left font-medium text-surface-500">
                                  Created
                                </th>
                              </tr>
                            </thead>
                            <tbody>
                              {segments.map((seg) => (
                                <tr
                                  key={seg.readSeq}
                                  className="border-b border-surface-50 last:border-0 hover:bg-surface-50"
                                >
                                  <td className="px-4 py-3 font-mono text-surface-600">
                                    {seg.readSeq}
                                  </td>
                                  <td className="px-4 py-3 font-mono text-surface-600">
                                    {seg.startOffset} - {seg.endOffset}
                                  </td>
                                  <td className="px-4 py-3 text-surface-900">
                                    {seg.messageCount}
                                  </td>
                                  <td className="px-4 py-3 text-surface-600">
                                    {formatBytes(seg.sizeBytes)}
                                  </td>
                                  <td className="px-4 py-3 text-surface-500">
                                    {formatDate(seg.createdAt)}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Messages area */}
      <div className="flex-1 overflow-hidden bg-surface-50">
        <ScrollArea className="h-full" ref={parentRef}>
          <div className="p-4 space-y-2">
            {messages.length === 0 && (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <div className="w-12 h-12 rounded-full bg-surface-100 flex items-center justify-center mb-4">
                  <Radio className="w-6 h-6 text-surface-400" />
                </div>
                <p className="text-surface-500 text-sm">
                  Listening for new messages...
                </p>
              </div>
            )}
            {messages.length !== 0 ? (
              isJsonStream ? (
                <div
                  style={{
                    height: `${virtualizer.getTotalSize()}px`,
                    width: "100%",
                    position: "relative",
                  }}
                >
                  {virtualizer.getVirtualItems().map((virtualItem) => (
                    <div
                      key={virtualItem.key}
                      data-index={virtualItem.index}
                      ref={virtualizer.measureElement}
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        width: "100%",
                        transform: `translateY(${virtualItem.start}px)`,
                      }}
                    >
                      <Card className="mb-2 animate-fade-in">
                        <CardContent className="p-4">
                          <ReactJson
                            src={flatItems[virtualItem.index]}
                            collapsed={1}
                            name={false}
                            displayDataTypes={false}
                            enableClipboard={false}
                            theme={JSON_THEME}
                            style={{ fontSize: "13px" }}
                          />
                        </CardContent>
                      </Card>
                    </div>
                  ))}
                </div>
              ) : (
                <Card>
                  <CardContent className="p-4">
                    <pre className="font-mono text-sm text-surface-700 whitespace-pre-wrap">
                      {messages.map((msg) => msg.data).join("")}
                    </pre>
                  </CardContent>
                </Card>
              )
            ) : null}
            <div ref={messagesEndRef} />
          </div>
        </ScrollArea>
      </div>

      {/* Write section */}
      {!isRegistryStream && (
        <div className="border-t border-surface-200 bg-white">
          {typers.length > 0 && (
            <div className="px-4 py-2 text-xs text-surface-500 italic border-b border-surface-100">
              {typers.map((t) => t.userId.slice(0, 8)).join(", ")} typing...
            </div>
          )}
          <div className="p-4 flex gap-3">
            <Textarea
              placeholder="Type your message (Shift+Enter for new line)..."
              value={writeInput}
              onChange={(e) => {
                setWriteInput(e.target.value);
                startTyping();
              }}
              onKeyPress={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void writeToStream();
                }
              }}
              className="min-h-[60px] max-h-[120px] resize-none"
            />
            <Button
              onClick={writeToStream}
              disabled={isSending || !writeInput.trim()}
              className="self-end"
            >
              {isSending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Send className="w-4 h-4" />
              )}
              Send
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
