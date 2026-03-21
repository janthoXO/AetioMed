import { useParams, useNavigate } from "react-router-dom";
import { useCases } from "@/hooks/useCases";
import { Button } from "@/components/ui/button";
import { Loader2, ArrowRight } from "lucide-react";
import { TraceViewer } from "@/components/TraceViewer";

export function GeneratingCaseView() {
  const { caseId } = useParams();
  const navigate = useNavigate();
  const { getCase } = useCases();

  const matchedCase = caseId ? getCase(caseId) : undefined;

  if (!matchedCase) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground p-8">
        Case not found or not generating.
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden p-6 max-w-4xl mx-auto w-full gap-6">
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold tracking-tight">
            Generating Case: {matchedCase.diagnosis.name}
          </h1>
          {!matchedCase.createdAt && (
            <Loader2 className="animate-spin text-primary h-6 w-6" />
          )}
        </div>
        {matchedCase.createdAt && (
          <p className="text-muted-foreground">
            {matchedCase.diagnosis.icd} ·{" "}
            {new Date(matchedCase.createdAt).toLocaleString()}
          </p>
        )}
      </div>

      <div className="flex-1 flex flex-col min-h-75">
        {caseId && (
          <TraceViewer caseId={caseId} isCompleted={!!matchedCase.createdAt} />
        )}
      </div>

      <div className="flex justify-end pt-2">
        <Button
          disabled={!matchedCase.createdAt}
          onClick={() => navigate(`/cases/${caseId}`)}
          className="w-full sm:w-auto"
        >
          View Case details
          <ArrowRight className="ml-2 h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
