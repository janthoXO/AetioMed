import { useParams, Link } from "react-router-dom";
import { ArrowLeft, FileQuestion } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CaseDetail } from "@/components/CaseDetail";
import { useCases } from "@/hooks/useCases";

export default function CaseDetailPage() {
  const { caseId } = useParams<{ caseId: string }>();
  const { getCase, isLoading } = useCases();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[40vh]">
        <p className="text-muted-foreground">Loading case...</p>
      </div>
    );
  }

  const medicalCase = caseId ? getCase(caseId) : undefined;

  if (!medicalCase) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[40vh] space-y-4 text-center">
        <div className="rounded-full bg-muted p-6">
          <FileQuestion className="h-10 w-10 text-muted-foreground" />
        </div>
        <div className="space-y-2">
          <h2 className="text-xl font-semibold">Case Not Found</h2>
          <p className="text-muted-foreground">
            The case you're looking for doesn't exist or has been removed.
          </p>
        </div>
        <Button variant="outline" asChild>
          <Link to="/">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Home
          </Link>
        </Button>
      </div>
    );
  }

  return <CaseDetail medicalCase={medicalCase} />;
}
