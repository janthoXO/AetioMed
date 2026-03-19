import {
  Calendar,
  Tag,
  Stethoscope,
  ClipboardList,
  Activity,
  ScrollText,
  Trash2,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { Case } from "@/models/Case";
import { TraceViewer } from "./TraceViewer";
import { useCases } from "@/hooks/useCases";
import { useNavigate } from "react-router-dom";

type Props = {
  medicalCase: Case;
};

export function CaseDetail({ medicalCase }: Props) {
  const { deleteCase } = useCases();
  const navigate = useNavigate();

  const handleDelete = async () => {
    await deleteCase(medicalCase.id);
    navigate("/");
  };
  const {
    diagnosis,
    createdAt,
    chiefComplaint,
    anamnesis,
    procedures,
    generationFlags,
  } = medicalCase;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="space-y-2">
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-2xl font-bold tracking-tight">
            {diagnosis.name}
          </h1>
          {diagnosis.icd && (
            <Badge variant="secondary" className="text-sm">
              <Tag className="h-3 w-3" />
              {diagnosis.icd}
            </Badge>
          )}
        </div>
        <div className="flex gap-2">
          {generationFlags.map((flag) => (
            <Badge key={flag} variant="secondary" className="text-sm">
              {flag
                .replace(/([a-z])([A-Z])/g, "$1 $2")
                .split(" ")
                .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
                .join(" ")}
            </Badge>
          ))}
        </div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground flex-wrap justify-between">
          <div className="flex items-center gap-2">
            <Calendar className="h-4 w-4" />
            <span>{(createdAt ?? new Date()).toLocaleString()}</span>
          </div>

          {medicalCase.createdAt && (
            <div className="flex gap-2 items-center">
              <Dialog>
                <DialogTrigger asChild>
                  <Button variant="outline" size="sm" className="h-8">
                    <ScrollText className="mr-2 h-4 w-4" />
                    View Generation Traces
                  </Button>
                </DialogTrigger>
                <DialogContent className="flex flex-col p-6 max-h-[80vh] w-fit sm:max-w-[80vw]">
                  <DialogHeader className="shrink-0">
                    <DialogTitle>Generation Traces</DialogTitle>
                    <DialogDescription>
                      Execution logs for {diagnosis.name}
                    </DialogDescription>
                  </DialogHeader>
                  <div className="flex-1 overflow-auto pt-4 flex flex-col w-full">
                    <TraceViewer caseId={medicalCase.id} isCompleted={true} />
                  </div>
                </DialogContent>
              </Dialog>
              <Button
                variant="destructive"
                size="sm"
                className="h-8"
                onClick={handleDelete}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                Delete Case
              </Button>
            </div>
          )}
        </div>
      </div>

      <Separator />

      {/* Chief Complaint */}
      {chiefComplaint && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <Stethoscope className="h-5 w-5 text-primary" />
              Chief Complaint
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm leading-relaxed">{chiefComplaint}</p>
          </CardContent>
        </Card>
      )}

      {/* Anamnesis */}
      {anamnesis && anamnesis.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <ClipboardList className="h-5 w-5 text-primary" />
              Anamnesis
            </CardTitle>
            <CardDescription>
              {anamnesis.length} {anamnesis.length === 1 ? "entry" : "entries"}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {anamnesis.map((entry, index) => (
                <div key={index} className="space-y-1">
                  <h4 className="text-sm font-semibold text-foreground">
                    {entry.category}
                  </h4>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    {entry.answer}
                  </p>
                  {index < anamnesis.length - 1 && (
                    <Separator className="mt-3" />
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Procedures */}
      {procedures && procedures.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <Activity className="h-5 w-5 text-primary" />
              Procedures
            </CardTitle>
            <CardDescription>
              {procedures.length}{" "}
              {procedures.length === 1 ? "procedure" : "procedures"}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {procedures.map((proc, index) => (
                <div key={index} className="space-y-1">
                  <h4 className="text-sm font-semibold text-foreground">
                    {proc.name}
                  </h4>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    {proc.relevance}
                  </p>
                  {index < procedures.length - 1 && (
                    <Separator className="mt-3" />
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Empty state if nothing generated yet */}
      {!chiefComplaint &&
        (!anamnesis || anamnesis.length === 0) &&
        (!procedures || procedures.length === 0) && (
          <Card>
            <CardContent className="py-8 text-center text-muted-foreground">
              No generated content for this case yet.
            </CardContent>
          </Card>
        )}
    </div>
  );
}
