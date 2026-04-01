import { useParams, Link } from "react-router-dom";
import { useCases } from "@/hooks/useCases";
import { Button } from "@/components/ui/button";
import { ScrollText } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { RunResult } from "@/components/RunResult";

export default function RunResultPage() {
  const params = useParams();
  const caseId = Number(params.caseId);
  const runId = Number(params.runId);
  const { getRun } = useCases();

  const run = getRun(caseId!, runId!);

  if (!run) {
    return (
      <div className="p-8 text-center text-muted-foreground">
        Run not found.
      </div>
    );
  }

  return (
    <div className="flex flex-col space-y-6 flex-1 w-full">
      <div className="flex flex-row items-center justify-between">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          {run.llmConfig ? (
            <Badge variant="outline" className="text-xs font-normal">
              {run.llmConfig.provider} - {run.llmConfig.model}
            </Badge>
          ) : (
            "Run Details"
          )}
        </h2>

        <Button variant="outline" size="sm" className="h-8" asChild>
          <Link to={`/cases/${caseId}/runs/${runId}/traces`}>
            <ScrollText className="mr-2 h-4 w-4" />
            Traces
          </Link>
        </Button>
      </div>

      <RunResult run={run} />
    </div>
  );
}
