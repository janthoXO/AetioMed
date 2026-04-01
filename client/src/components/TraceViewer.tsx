import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useTraces } from "@/hooks/useTraces";
import ReactMarkdown from "react-markdown";
import type { CaseRun } from "@/models/Case";
import { AlertCircle, RefreshCw } from "lucide-react";

type TraceViewerProps = {
  run: CaseRun;
};

export function TraceViewer({ run }: TraceViewerProps) {
  const isCompleted = run.status !== "generating";
  const { traces, warning, error, reconnect } = useTraces(
    run.traceId,
    isCompleted
  );

  return (
    <div className="flex-1 bg-card text-card-foreground rounded-md border p-4 font-mono text-sm shadow-inner flex flex-col overflow-auto">
      {error && !isCompleted && (
        <div className="mb-4 bg-destructive/10 border border-destructive/20 rounded-md p-3 flex items-center justify-between">
          <div className="flex items-center gap-2 text-destructive">
            <AlertCircle className="h-4 w-4" />
            <span className="text-sm font-medium">{error}</span>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={reconnect}
            className="h-8 gap-2"
          >
            <RefreshCw className="h-3 w-3" />
            Reconnect
          </Button>
        </div>
      )}
      {warning && (
        <div className="mb-4 whitespace-normal">
          <Badge variant="destructive">{warning}</Badge>
        </div>
      )}
      <div className="flex flex-col gap-2 pb-4">
        {traces.length === 0 ? (
          <span className="text-muted-foreground">
            {isCompleted ? "No history available." : "Waiting for traces..."}
          </span>
        ) : (
          traces.map((t, i) => (
            <div key={i} className="flex gap-4">
              <span className="text-muted-foreground shrink-0">
                {new Date(t.timestamp).toLocaleTimeString()}
              </span>
              <div
                className={`prose dark:prose-invert ${t.category === "error" ? "text-destructive" : t.category === "warn" ? "text-warning" : ""}`}
              >
                <ReactMarkdown>{t.message}</ReactMarkdown>
              </div>
            </div>
          ))
        )}
        {isCompleted && traces.length > 0 && (
          <div className="flex gap-4 mt-2">
            <span className="text-success leading-none">✓ Trace finished.</span>
          </div>
        )}
      </div>
    </div>
  );
}
