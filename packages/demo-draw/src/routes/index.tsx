import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { createServerFn } from "@tanstack/react-start";
import { getRoomConfig } from "@/lib/config";
import { getWriteStream } from "@/lib/stream";

export const Route = createFileRoute("/")({
  component: LandingPage,
});

// Example server function
const createRoom = createServerFn({ method: "POST" }).handler(async () => {
  const { coreUrl, projectId, writeToken } = await getRoomConfig();
  const roomId = crypto.randomUUID().slice(0, 8);
  const ds = getWriteStream(coreUrl, projectId, roomId, writeToken);
  await ds.create({ contentType: "application/json" });
  await ds.append("{}", { contentType: "application/json" });
  return roomId;
});

function LandingPage() {
  const navigate = useNavigate();

  const handleCreateRoom = useCallback(async () => {
    let roomId = await createRoom();
    navigate({ to: "/room/$roomId", params: { roomId } });
  }, [navigate]);

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader
          title="Draw Together"
          description="Create a room and share the link. Anyone with it can draw in real-time."
        />
        <CardContent>
          <Button intent="primary" size="lg" className="w-full" onPress={handleCreateRoom}>
            Create Room
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
