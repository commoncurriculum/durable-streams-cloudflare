import { useState, useCallback } from "react";
import { Button } from "@/components/ui/button";

interface HeaderProps {
  roomId: string;
}

export function Header({ roomId }: HeaderProps) {
  const [copied, setCopied] = useState(false);

  const handleCopyLink = useCallback(async () => {
    await navigator.clipboard.writeText(window.location.href);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, []);

  return (
    <header className="flex items-center justify-between border-b px-4 py-3">
      <div className="flex items-center gap-3">
        <span className="inline-block h-2 w-2 rounded-full bg-emerald-400" />
        <h1 className="text-base font-semibold tracking-tight">
          Draw Together
        </h1>
        <span className="text-sm text-muted-fg">Room: {roomId}</span>
      </div>
      <Button
        intent="secondary"
        size="sm"
        onPress={handleCopyLink}
      >
        {copied ? "Copied!" : "Copy Link"}
      </Button>
    </header>
  );
}
