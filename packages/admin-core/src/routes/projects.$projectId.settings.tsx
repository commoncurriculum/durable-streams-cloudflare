import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getProjectConfig, updateProjectPrivacy } from "../lib/analytics";
import { Switch } from "../components/ui/switch";

export const Route = createFileRoute("/projects/$projectId/settings")({
  component: ProjectSettings,
});

function ProjectSettings() {
  const { projectId } = Route.useParams();
  const queryClient = useQueryClient();

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

  const isPublic = config?.isPublic ?? false;

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
    </div>
  );
}
