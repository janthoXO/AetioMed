import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  User,
  Stethoscope,
  ClipboardList,
  Activity,
  RefreshCw,
} from "lucide-react";
import type { CaseRun } from "@/models/Case";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogClose,
} from "@/components/ui/dialog";
import { useCases } from "@/hooks/useCases";

type RunResultProps = {
  run: CaseRun;
};

export function RunResult({ run }: RunResultProps) {
  const { retryRun } = useCases();
  const [retryDialogOpen, setRetryDialogOpen] = useState(false);

  const handleRetry = async () => {
    setRetryDialogOpen(false);
    if (run.caseId && run.runId) {
      await retryRun(run.caseId, run.runId);
    }
  };

  return (
    <div className="flex flex-col space-y-6 flex-1 w-full">
      {run.status === "generating" && (
        <div className="flex flex-col items-center justify-center p-12 space-y-4 border rounded-lg bg-card/50">
          <Spinner className="h-8 w-8 text-primary" />
          <p className="text-sm text-muted-foreground animate-pulse">
            Generating content...
          </p>
        </div>
      )}

      {run.status === "error" && (
        <Card className="border-destructive/50 bg-destructive/10">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-destructive text-lg">
              Generation Error
            </CardTitle>
            <Dialog open={retryDialogOpen} onOpenChange={setRetryDialogOpen}>
              <DialogTrigger asChild>
                <Button variant="outline" size="sm" className="gap-2">
                  <RefreshCw className="h-4 w-4" />
                  Retry
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Retry Generation</DialogTitle>
                  <DialogDescription>
                    Are you sure you want to retry generation for this run? This
                    will restart the AI process.
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <DialogClose asChild>
                    <Button variant="ghost">Cancel</Button>
                  </DialogClose>
                  <Button onClick={handleRetry}>Confirm Retry</Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-destructive/80">
              {run.error ?? "Unknown error occurred"}
            </p>
          </CardContent>
        </Card>
      )}

      {run.status === "complete" && (
        <div className="space-y-6 flex-1">
          {run.patient && (
            <Card>
              <CardHeader className="py-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <User className="h-4 w-4 text-primary" />
                  Patient Details
                </CardTitle>
              </CardHeader>
              <CardContent className="pb-4">
                <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                  <div>
                    <span className="text-muted-foreground block text-xs">
                      Age
                    </span>
                    <span className="font-medium">{run.patient.age} years</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground block text-xs">
                      Gender
                    </span>
                    <span className="font-medium capitalize">
                      {run.patient.gender}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground block text-xs">
                      Height
                    </span>
                    <span className="font-medium">{run.patient.height} cm</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground block text-xs">
                      Weight
                    </span>
                    <span className="font-medium">{run.patient.weight} kg</span>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {run.chiefComplaint && (
            <Card>
              <CardHeader className="py-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Stethoscope className="h-4 w-4 text-primary" />
                  Chief Complaint
                </CardTitle>
              </CardHeader>
              <CardContent className="pb-4">
                <p className="text-sm leading-relaxed">{run.chiefComplaint}</p>
              </CardContent>
            </Card>
          )}

          {run.anamnesis && run.anamnesis.length > 0 && (
            <Card>
              <CardHeader className="py-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <ClipboardList className="h-4 w-4 text-primary" />
                  Anamnesis
                </CardTitle>
              </CardHeader>
              <CardContent className="pb-4">
                <div className="space-y-3">
                  {run.anamnesis.map((entry, index) => (
                    <div key={index} className="space-y-1">
                      <h4 className="text-sm font-semibold text-foreground">
                        {entry.category}
                      </h4>
                      <p className="text-sm text-muted-foreground leading-relaxed">
                        {entry.answer}
                      </p>
                      {index < run.anamnesis!.length - 1 && (
                        <Separator className="mt-2" />
                      )}
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {run.procedures && run.procedures.length > 0 && (
            <Card>
              <CardHeader className="py-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Activity className="h-4 w-4 text-primary" />
                  Procedures
                </CardTitle>
              </CardHeader>
              <CardContent className="pb-4">
                <div className="space-y-2">
                  {run.procedures.map((proc, index) => (
                    <div
                      key={index}
                      className="flex justify-between items-center bg-muted/50 p-2 rounded-md"
                    >
                      <span className="text-sm font-medium">{proc.name}</span>
                      <Badge
                        variant={
                          proc.relevance === "High"
                            ? "default"
                            : proc.relevance === "Medium"
                              ? "secondary"
                              : "outline"
                        }
                        className="text-xs"
                      >
                        {proc.relevance}
                      </Badge>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
