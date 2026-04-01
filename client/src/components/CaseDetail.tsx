import { useState } from "react";
import { Calendar, Tag, Trash2, Plus } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import type { Case } from "@/models/Case";
import { RunDetail } from "./RunDetail";
import { useCases } from "@/hooks/useCases";
import { useFeatures } from "@/hooks/useFeatures";
import { useNavigate } from "react-router-dom";
import { LLMConfigForm } from "./LLMConfigForm";
import { useLLMConfig } from "@/hooks/useLLMConfig";

type Props = {
  medicalCase: Case;
};

const MAX_COMPARISON_RUNS = 3;

export function CaseDetail({ medicalCase }: Props) {
  const { deleteCase } = useCases();
  const { hasCustomLLM } = useFeatures();
  const navigate = useNavigate();
  const [modalOpen, setModalOpen] = useState(false);
  const [caseToDelete, setCaseToDelete] = useState<number | null>(null);

  const handleDelete = () => {
    setCaseToDelete(medicalCase.id!);
  };

  const confirmDelete = async () => {
    if (caseToDelete === null) return;
    await deleteCase(caseToDelete);
    navigate("/");
    setCaseToDelete(null);
  };

  const { diagnosis, createdAt, generationFlags, runs = [] } = medicalCase;

  // We only show + add run if we have custom LLM enabled, and we aren't at the limit
  const canAddRun = hasCustomLLM && runs.length < MAX_COMPARISON_RUNS;

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
              <Tag className="h-3 w-3 mr-1" />
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
            <span>
              {(createdAt ? new Date(createdAt) : new Date()).toLocaleString()}
            </span>
          </div>

          {createdAt && (
            <div className="flex gap-2 items-center">
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

      {/* Grid of Runs */}
      <div className="flex flex-row overflow-x-auto gap-4 min-h-[50vh]">
        {runs.map((run, idx) => (
          <RunDetail key={run.runId} run={run} index={idx} />
        ))}

        {canAddRun && (
          <div
            className="min-w-87.5 max-w-200 flex flex-col justify-center items-center border-2 border-dashed rounded-xl p-8 hover:bg-muted/50 cursor-pointer transition-colors"
            onClick={() => setModalOpen(true)}
          >
            <Plus className="h-10 w-10 text-muted-foreground mb-4" />
            <p className="text-muted-foreground font-medium">
              Add Comparison Run
            </p>
            <p className="text-xs text-muted-foreground mt-2 text-center max-w-50">
              Generate another variation with different LLM configurations.
            </p>
          </div>
        )}
      </div>

      <AddRunModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        medicalCase={medicalCase}
      />

      <Dialog
        open={caseToDelete !== null}
        onOpenChange={(open) => !open && setCaseToDelete(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Case</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this case? This action cannot be
              undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCaseToDelete(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmDelete}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// Very similar to GenerateCaseModal but tied to an existing case specification
function AddRunModal({
  open,
  onOpenChange,
  medicalCase,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  medicalCase: Case;
}) {
  const { addRunToCase } = useCases();
  const llmConfigState = useLLMConfig("");

  const resetForm = () => {
    llmConfigState.reset();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!llmConfigState.model.trim()) return;

    const request = {
      diagnosis: medicalCase.diagnosis.name,
      icd: medicalCase.diagnosis.icd,
      generationFlags: medicalCase.generationFlags,
      language: medicalCase.language,
    };

    const llmConfig = llmConfigState.getLLMConfig();

    resetForm();
    onOpenChange(false);

    try {
      await addRunToCase(medicalCase.id!, request, llmConfig);
    } catch (error) {
      console.error("Addition failed:", error);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(val) => {
        onOpenChange(val);
        if (!val) resetForm();
      }}
    >
      <DialogContent className="sm:max-w-106.25">
        <DialogHeader>
          <DialogTitle>Add Comparison Run</DialogTitle>
          <DialogDescription>
            Specify a new LLM configuration to run alongside the existing
            generations.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 pt-4">
          <div className="space-y-4">
            <LLMConfigForm config={llmConfigState} />
          </div>
          <DialogFooter className="mt-6">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!llmConfigState.model.trim()}>
              Start Run
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
