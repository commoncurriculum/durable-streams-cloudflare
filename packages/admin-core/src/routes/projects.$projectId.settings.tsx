import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  getProjectConfig,
  updateProjectPrivacy,
  addCorsOrigin,
  removeCorsOrigin,
  generateSigningKey,
  revokeSigningKey,
} from "../lib/analytics";
import { Switch } from "../components/ui/switch";

export const Route = createFileRoute("/projects/$projectId/settings")({
  component: ProjectSettings,
});

function ProjectSettings() {
  const { projectId } = Route.useParams();
  const queryClient = useQueryClient();
  const [newOrigin, setNewOrigin] = useState("");

  const { data: config } = useQuery({
    queryKey: ["projectConfig", projectId],
    queryFn: () => getProjectConfig({ data: projectId }),
    refetchInterval: 5000,
  });

  const privacyMutation = useMutation({
    mutationFn: (isPublic: boolean) =>
      updateProjectPrivacy({ data: { projectId, isPublic } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["projectConfig", projectId] });
    },
  });

  const addOriginMutation = useMutation({
    mutationFn: (origin: string) =>
      addCorsOrigin({ data: { projectId, origin } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["projectConfig", projectId] });
      setNewOrigin("");
    },
  });

  const removeOriginMutation = useMutation({
    mutationFn: (origin: string) =>
      removeCorsOrigin({ data: { projectId, origin } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["projectConfig", projectId] });
    },
  });

  const generateKeyMutation = useMutation({
    mutationFn: () => generateSigningKey({ data: projectId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["projectConfig", projectId] });
    },
  });

  const revokeKeyMutation = useMutation({
    mutationFn: (secret: string) =>
      revokeSigningKey({ data: { projectId, secret } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["projectConfig", projectId] });
    },
  });

  const isPublic = config?.isPublic ?? false;
  const corsOrigins = config?.corsOrigins ?? [];
  const keyCount = config?.signingSecrets?.length ?? 0;

  return (
    <div className="space-y-8">
      <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-6">
        <h3 className="mb-4 text-sm font-medium text-zinc-400">Privacy</h3>
        <div className="flex items-center gap-4">
          <Switch
            isSelected={isPublic}
            onChange={(selected) => privacyMutation.mutate(selected)}
          >
            {isPublic ? "Public" : "Private"}
          </Switch>
        </div>
      </div>

      <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-6">
        <h3 className="mb-4 text-sm font-medium text-zinc-400">CORS Origins</h3>
        {corsOrigins.length > 0 && (
          <ul className="mb-4 space-y-2">
            {corsOrigins.map((origin) => (
              <li key={origin} className="flex items-center justify-between rounded bg-zinc-800 px-3 py-2">
                <span className="font-mono text-sm text-zinc-300">{origin}</span>
                <button
                  type="button"
                  onClick={() => removeOriginMutation.mutate(origin)}
                  className="text-xs text-red-400 hover:text-red-300"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex gap-2">
          <input
            type="text"
            placeholder="https://example.com"
            value={newOrigin}
            onChange={(e) => setNewOrigin(e.target.value)}
            className="flex-1 rounded border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-200 placeholder-zinc-500"
          />
          <button
            type="button"
            onClick={() => {
              if (newOrigin.trim()) addOriginMutation.mutate(newOrigin.trim());
            }}
            disabled={!newOrigin.trim()}
            className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
          >
            Add
          </button>
        </div>
      </div>

      <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-6">
        <h3 className="mb-4 text-sm font-medium text-zinc-400">Signing Keys</h3>
        <div className="mb-4 flex items-center justify-between">
          <span className="text-sm text-zinc-300">
            {keyCount} {keyCount === 1 ? "key" : "keys"}
          </span>
          <button
            type="button"
            onClick={() => generateKeyMutation.mutate()}
            className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500"
          >
            Generate Key
          </button>
        </div>
        {config?.signingSecrets && config.signingSecrets.length > 0 && (
          <ul className="space-y-2">
            {config.signingSecrets.map((secret, i) => (
              <li key={i} className="flex items-center justify-between rounded bg-zinc-800 px-3 py-2">
                <span className="font-mono text-sm text-zinc-500">
                  {secret.slice(0, 8)}...{secret.slice(-4)}
                </span>
                <button
                  type="button"
                  onClick={() => revokeKeyMutation.mutate(secret)}
                  className="text-xs text-red-400 hover:text-red-300"
                >
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
