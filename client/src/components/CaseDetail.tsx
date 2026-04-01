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
import { Input } from "@/components/ui/input";
import type { Case, LLMConfig, LLMProvider } from "@/models/Case";
import { RunDetail } from "./RunDetail";
import { useCases } from "@/hooks/useCases";
import { useFeatures } from "@/hooks/useFeatures";
import { useNavigate } from "react-router-dom";

type Props = {
  medicalCase: Case;
};

const MAX_COMPARISON_RUNS = 3;

export function CaseDetail({ medicalCase }: Props) {
  const { deleteCase } = useCases();
  const { hasCustomLLM } = useFeatures();
  const navigate = useNavigate();
  const [modalOpen, setModalOpen] = useState(false);

  const handleDelete = async () => {
    await deleteCase(medicalCase.id!);
    navigate("/");
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
  const [llmProvider, setLLMProvider] = useState<LLMProvider>("ollama");
  const [llmModel, setLLMModel] = useState("");
  const [llmApiKey, setLLMApiKey] = useState("");
  const [llmUrl, setLLMUrl] = useState("");

  const resetForm = () => {
    setLLMProvider("ollama");
    setLLMModel("");
    setLLMApiKey("");
    setLLMUrl("");
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!llmModel.trim()) return;

    const request = {
      diagnosis: medicalCase.diagnosis.name,
      icd: medicalCase.diagnosis.icd,
      generationFlags: medicalCase.generationFlags,
      language: medicalCase.language,
    };

    const llmConfig: LLMConfig = {
      provider: llmProvider,
      model: llmModel.trim(),
      ...(llmApiKey.trim() ? { apiKey: llmApiKey.trim() } : {}),
      ...(llmUrl.trim() ? { url: llmUrl.trim() } : {}),
    };

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
            <div className="space-y-2">
              <label className="text-sm font-medium">Provider</label>
              <select
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background"
                value={llmProvider}
                onChange={(e) => setLLMProvider(e.target.value as LLMProvider)}
              >
                <option value="ollama">Ollama</option>
                <option value="google">Google</option>
              </select>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">
                Model <span className="text-destructive">*</span>
              </label>
              <Input
                placeholder="e.g. llama3"
                value={llmModel}
                onChange={(e) => setLLMModel(e.target.value)}
                required
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">API Key (optional)</label>
              <Input
                type="password"
                placeholder="Leave blank if not needed"
                value={llmApiKey}
                onChange={(e) => setLLMApiKey(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">API URL (optional)</label>
              <Input
                type="url"
                placeholder="e.g. http://localhost:11434"
                value={llmUrl}
                onChange={(e) => setLLMUrl(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter className="mt-6">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!llmModel.trim()}>
              Start Run
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
