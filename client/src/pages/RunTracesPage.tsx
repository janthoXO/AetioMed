import { useParams, Link } from "react-router-dom";
import { useCases } from "@/hooks/useCases";
import { TraceViewer } from "@/components/TraceViewer";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";

export default function RunTracesPage() {
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
    <div className="flex flex-col space-y-6 flex-1 w-full h-full">
      <div className="flex flex-row items-center gap-4 border-b pb-4">
        <Button variant="ghost" size="icon" asChild className="shrink-0">
          <Link to={`/cases/${caseId}/runs/${runId}`}>
            <ArrowLeft className="h-5 w-5" />
          </Link>
        </Button>
        <h2 className="text-xl font-bold tracking-tight">Generation Traces</h2>
      </div>

      <div className="flex-1 min-h-0 bg-background rounded-md border shadow-sm flex flex-col pt-4 overflow-hidden">
        <TraceViewer run={run} />
      </div>
    </div>
  );
}
