import { useState, useEffect, useRef, useCallback } from "react";
import {
  Radio,
  Wifi,
  WifiOff,
  Trash2,
  ArrowDown,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { cn } from "../lib/utils";

interface LiveMessage {
  id: string;
  timestamp: Date;
  streamId: string;
  data: string;
  offset: string;
}

interface LiveMessagesPanelProps {
  sessionId: string;
  className?: string;
}

const MAX_MESSAGES = 100;

export function LiveMessagesPanel({
  sessionId,
  className,
}: LiveMessagesPanelProps) {
  const [isExpanded, setIsExpanded] = useState(true);
  const [isConnected, setIsConnected] = useState(false);
  const [messages, setMessages] = useState<LiveMessage[]>([]);
  const [autoScroll, setAutoScroll] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const eventSourceRef = useRef<EventSource | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const messageIdRef = useRef(0);

  const connect = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    setError(null);
    // offset=-1 starts from beginning, offset=now starts from current tail
    const url = `/v1/stream/subscriptions/${encodeURIComponent(sessionId)}?live=sse&offset=now`;
    const eventSource = new EventSource(url);
    eventSourceRef.current = eventSource;

    eventSource.onopen = () => {
      setIsConnected(true);
      setError(null);
    };

    eventSource.onmessage = (event) => {
      try {
        // Parse the SSE data - expecting envelope format
        const envelope = JSON.parse(event.data) as {
          streamId?: string;
          offset?: string;
          data?: unknown;
        };

        const message: LiveMessage = {
          id: `msg-${++messageIdRef.current}`,
          timestamp: new Date(),
          streamId: envelope.streamId || "unknown",
          offset: envelope.offset || event.lastEventId || "?",
          data:
            typeof envelope.data === "string"
              ? envelope.data
              : JSON.stringify(envelope.data, null, 2),
        };

        setMessages((prev) => {
          const newMessages = [...prev, message];
          return newMessages.length > MAX_MESSAGES
            ? newMessages.slice(-MAX_MESSAGES)
            : newMessages;
        });
      } catch {
        // If not JSON, treat as plain text
        const message: LiveMessage = {
          id: `msg-${++messageIdRef.current}`,
          timestamp: new Date(),
          streamId: "subscription",
          offset: event.lastEventId || "?",
          data: event.data,
        };

        setMessages((prev) => {
          const newMessages = [...prev, message];
          return newMessages.length > MAX_MESSAGES
            ? newMessages.slice(-MAX_MESSAGES)
            : newMessages;
        });
      }
    };

    eventSource.onerror = () => {
      setIsConnected(false);
      if (eventSource.readyState === EventSource.CLOSED) {
        setError("Connection closed");
      } else {
        setError("Connection error");
      }
    };
  }, [sessionId]);

  const disconnect = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    setIsConnected(false);
  }, []);

  const clearMessages = () => {
    setMessages([]);
  };

  // Auto-scroll effect
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, autoScroll]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
    };
  }, []);

  const formatTime = (date: Date): string => {
    return date.toLocaleTimeString("en-US", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  };

  return (
    <Card className={className}>
      <CardHeader
        className="cursor-pointer"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <Radio className="w-4 h-4 text-surface-500" />
            Live Messages
            {messages.length > 0 && (
              <Badge variant="secondary" className="text-xs">
                {messages.length}
              </Badge>
            )}
          </CardTitle>
          <div className="flex items-center gap-2">
            {isConnected ? (
              <Badge variant="success" className="gap-1">
                <Wifi className="w-3 h-3" />
                Connected
              </Badge>
            ) : (
              <Badge variant="secondary" className="gap-1">
                <WifiOff className="w-3 h-3" />
                Disconnected
              </Badge>
            )}
            {isExpanded ? (
              <ChevronUp className="w-4 h-4 text-surface-400" />
            ) : (
              <ChevronDown className="w-4 h-4 text-surface-400" />
            )}
          </div>
        </div>
      </CardHeader>

      {isExpanded && (
        <CardContent className="pt-0">
          {/* Controls */}
          <div className="flex items-center justify-between gap-2 mb-3 pb-3 border-b border-surface-100">
            <div className="flex items-center gap-2">
              <Button
                variant={isConnected ? "secondary" : "default"}
                size="sm"
                onClick={isConnected ? disconnect : connect}
              >
                {isConnected ? (
                  <>
                    <WifiOff className="w-3 h-3" />
                    Disconnect
                  </>
                ) : (
                  <>
                    <Wifi className="w-3 h-3" />
                    Connect
                  </>
                )}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={clearMessages}
                disabled={messages.length === 0}
              >
                <Trash2 className="w-3 h-3" />
                Clear
              </Button>
            </div>
            <label className="flex items-center gap-2 text-sm text-surface-600 cursor-pointer">
              <input
                type="checkbox"
                checked={autoScroll}
                onChange={(e) => setAutoScroll(e.target.checked)}
                className="rounded border-surface-300"
              />
              <ArrowDown className="w-3 h-3" />
              Auto-scroll
            </label>
          </div>

          {/* Error message */}
          {error && (
            <div className="px-3 py-2 mb-3 text-sm text-warning-600 bg-warning-50 rounded-lg">
              {error}
            </div>
          )}

          {/* Messages */}
          <div
            ref={scrollRef}
            className="h-64 overflow-auto rounded border border-surface-100 bg-surface-50/50"
          >
            {messages.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-surface-400">
                <Radio className="w-8 h-8 mb-2" />
                <p className="text-sm">
                  {isConnected
                    ? "Waiting for messages..."
                    : "Click Connect to start receiving messages"}
                </p>
              </div>
            ) : (
              <div className="space-y-1 font-mono text-xs p-2">
                {messages.map((msg) => (
                  <div
                    key={msg.id}
                    className={cn(
                      "flex gap-3 p-2 rounded hover:bg-white",
                      "border-l-2 border-transparent hover:border-primary-300"
                    )}
                  >
                    <span className="text-surface-400 shrink-0 tabular-nums">
                      {formatTime(msg.timestamp)}
                    </span>
                    <span className="text-primary-600 shrink-0 min-w-[80px] truncate">
                      {msg.streamId}
                    </span>
                    <span className="text-surface-700 break-all whitespace-pre-wrap">
                      {msg.data}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </CardContent>
      )}
    </Card>
  );
}
