import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { useTraces } from "@/hooks/useTraces";

type TraceViewerProps = {
  caseId: string;
  isCompleted: boolean;
};

export function TraceViewer({ caseId, isCompleted }: TraceViewerProps) {
  const { traces, warning } = useTraces(caseId, isCompleted);

  return (
    <div className="flex-1 bg-zinc-950 text-zinc-50 rounded-md border p-4 font-mono text-sm shadow-inner flex flex-col">
      {warning && (
        <div className="mb-4 whitespace-normal">
          <Badge variant="destructive">{warning}</Badge>
        </div>
      )}
      <ScrollArea className="flex-1 pr-4">
        <div className="flex flex-col gap-2 pb-4 whitespace-nowrap w-max">
          {traces.length === 0 ? (
            <span className="text-zinc-500">
              {isCompleted ? "No history available." : "Waiting for traces..."}
            </span>
          ) : (
            traces.map((t, i) => (
              <div key={i} className="flex gap-4">
                <span className="text-zinc-500 shrink-0">
                  {new Date(t.timestamp).toLocaleTimeString()}
                </span>
                <span
                  className={`${t.message.includes("Error") ? "text-red-400" : "text-zinc-300"}`}
                >
                  {t.message}
                </span>
              </div>
            ))
          )}
          {isCompleted && traces.length > 0 && (
            <div className="flex gap-4 mt-2">
              <span className="text-green-500 leading-none">
                ✓ Trace finished.
              </span>
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
