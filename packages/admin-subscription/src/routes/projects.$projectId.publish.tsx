import { createFileRoute } from "@tanstack/react-router";
import { useState, useCallback, useEffect } from "react";
import { sendSessionAction } from "../lib/analytics";
import { useStreamMeta } from "../lib/queries";
import { TextField } from "../components/ui/text-field";
import { Textarea } from "../components/ui/textarea";
import { Button } from "../components/ui/button";
import { Label } from "../components/ui/field";
import { Input } from "react-aria-components";

const CONTENT_TYPES = [
  "application/json",
  "text/plain",
  "application/octet-stream",
  "text/html",
];

export const Route = createFileRoute("/projects/$projectId/publish")({
  component: PublishPage,
});

function PublishPage() {
  const { projectId } = Route.useParams();
  const [streamId, setStreamId] = useState("");
  const [contentType, setContentType] = useState("application/json");
  const [body, setBody] = useState('{"hello":"world"}');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  const debouncedStreamId = useDebounced(streamId.trim(), 500);
  const { data: streamMeta } = useStreamMeta(projectId, debouncedStreamId);

  useEffect(() => {
    if (streamMeta?.content_type) {
      setContentType(streamMeta.content_type);
    }
  }, [streamMeta?.content_type]);

  const handleSend = useCallback(async () => {
    if (!streamId.trim()) return;
    setSending(true);
    setResult(null);

    const MAX_RETRIES = 2;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const res = await sendSessionAction({
          data: {
            action: "publish",
            projectId,
            streamId: streamId.trim(),
            body,
            contentType,
          },
        });
        setResult({
          type: "success",
          message: `${res.status} ${res.statusText}`,
        });
        break;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (attempt < MAX_RETRIES && msg.includes("restarted")) {
          await new Promise((r) => setTimeout(r, 300));
          continue;
        }
        setResult({ type: "error", message: msg });
      }
    }
    setSending(false);
  }, [projectId, streamId, body, contentType]);

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <h2 className="text-lg font-semibold">Publish to Stream</h2>

      <TextField value={streamId} onChange={setStreamId}>
        <Label>Stream ID</Label>
        <Input
          placeholder="my-stream"
          className="mt-2 block w-full rounded-lg border border-input bg-transparent px-3 py-1.5 text-sm text-fg placeholder:text-muted-fg outline-hidden focus:border-ring/70 focus:ring-3 focus:ring-ring/20"
        />
      </TextField>

      <div className="space-y-2">
        <label
          htmlFor="content-type-select"
          className="text-sm font-medium text-fg"
        >
          Content Type
        </label>
        <select
          id="content-type-select"
          value={contentType}
          onChange={(e) => setContentType(e.target.value)}
          className="block w-full rounded-lg border border-input bg-transparent px-3 py-1.5 text-sm text-fg outline-hidden focus:border-ring/70 focus:ring-3 focus:ring-ring/20"
        >
          {CONTENT_TYPES.map((ct) => (
            <option key={ct} value={ct}>
              {ct}
            </option>
          ))}
        </select>
      </div>

      <TextField value={body} onChange={setBody}>
        <Label>Message Body</Label>
        <Textarea rows={4} className="mt-2 font-mono" />
      </TextField>

      <Button
        intent="primary"
        className="w-full"
        isDisabled={sending || !streamId.trim()}
        onPress={handleSend}
      >
        {sending ? "Sending..." : "Send"}
      </Button>

      {result && (
        <div
          className={`rounded-lg border px-4 py-3 text-sm ${
            result.type === "success"
              ? "border-success/30 bg-success-subtle text-success-subtle-fg"
              : "border-danger/30 bg-danger-subtle text-danger-subtle-fg"
          }`}
        >
          {result.type === "success" ? "Success" : "Error"}: {result.message}
        </div>
      )}
    </div>
  );
}

function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}
