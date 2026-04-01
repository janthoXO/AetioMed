import { useState } from "react";
import type { CaseRun } from "@/models/Case";
import { TraceViewer } from "@/components/TraceViewer";
import { RunResult } from "@/components/RunResult";
import { Badge } from "@/components/ui/badge";
import { ScrollText, FileText } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group";

type Props = {
  run: CaseRun;
  index: number;
};

export function RunDetail({ run, index }: Props) {
  const [view, setView] = useState<"detail" | "traces">("detail");

  return (
    <div className="flex-1 min-w-100 max-w-300 flex flex-col space-y-6 bg-card border rounded-xl p-6 shadow-sm overflow-auto">
      {/* Header */}
      <div className="flex flex-row items-center justify-between border-b pb-4">
        <h2 className="text-lg font-semibold flex flex-wrap items-center gap-2">
          Run {index + 1}
          {run.llmConfig && (
            <Badge variant="outline" className="text-xs font-normal">
              {run.llmConfig.provider} - {run.llmConfig.model}
            </Badge>
          )}
        </h2>

        <ToggleGroup
          type="single"
          variant="outline"
          value={view}
          onValueChange={(value) => setView(value as "detail" | "traces")}
        >
          <ToggleGroupItem value="detail">
            <FileText className="mr-2 h-4 w-4" />
            Case
          </ToggleGroupItem>
          <ToggleGroupItem value="traces">
            <ScrollText className="mr-2 h-4 w-4" />
            Traces
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      <div className="flex-1 flex flex-col">
        {view === "detail" ? (
          <RunResult run={run} />
        ) : (
          <TraceViewer run={run} />
        )}
      </div>
    </div>
  );
}
