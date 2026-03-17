import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { useCases } from "@/hooks/useCases";
import type { GenerationFlag } from "@/models/GenerationFlags";
import { ICDCodePattern } from "@/models/Diagnosis";

const GENERATION_FLAGS: { value: GenerationFlag; label: string }[] = [
  { value: "chiefComplaint", label: "Chief Complaint" },
  { value: "anamnesis", label: "Anamnesis" },
  { value: "procedures", label: "Procedures" },
];

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function GenerateCaseModal({ open, onOpenChange }: Props) {
  const navigate = useNavigate();
  const { generateCase } = useCases();

  const [diagnosis, setDiagnosis] = useState("");
  const [icdCode, setIcdCode] = useState("");
  const [selectedFlags, setSelectedFlags] = useState<Set<GenerationFlag>>(
    new Set()
  );
  const [flagContexts, setFlagContexts] = useState<
    Partial<Record<GenerationFlag, string>>
  >({});
  const [generalContext, setGeneralContext] = useState("");
  const [icdError, setIcdError] = useState("");

  function resetForm() {
    setDiagnosis("");
    setIcdCode("");
    setSelectedFlags(new Set());
    setFlagContexts({});
    setGeneralContext("");
    setIcdError("");
  }

  function toggleFlag(flag: GenerationFlag) {
    setSelectedFlags((prev) => {
      const next = new Set(prev);
      if (next.has(flag)) {
        next.delete(flag);
        // Clear per-flag context when unchecked
        setFlagContexts((fc) => {
          const updated = { ...fc };
          delete updated[flag];
          return updated;
        });
      } else {
        next.add(flag);
      }
      return next;
    });
  }

  function updateFlagContext(flag: GenerationFlag, value: string) {
    setFlagContexts((prev) => ({ ...prev, [flag]: value }));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();

    // Validate ICD code if provided
    if (icdCode && !ICDCodePattern.test(icdCode)) {
      setIcdError("Invalid ICD code format (e.g. A00, A00.0)");
      return;
    }

    setIcdError("");

    const context: Record<string, string> = {};
    if (generalContext.trim()) {
      context.general = generalContext.trim();
    }
    for (const [flag, ctx] of Object.entries(flagContexts)) {
      if (ctx?.trim()) {
        context[flag] = ctx.trim();
      }
    }

    const request = {
      diagnosis: diagnosis.trim(),
      icd: icdCode.trim() || undefined,
      generationFlags: Array.from(selectedFlags),
      context: Object.keys(context).length > 0 ? context : undefined,
    };

    // Close modal immediately — skeleton in sidebar will show progress
    resetForm();
    onOpenChange(false);

    try {
      await generateCase(request);
    } catch (error) {
      console.error("Generation failed:", error);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        onOpenChange(value);
        if (!value) resetForm();
      }}
    >
      <DialogContent className="sm:max-w-[550px] max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-xl">Generate New Case</DialogTitle>
          <DialogDescription>
            Specify the diagnosis and select which sections to generate.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-5">
          {/* Diagnosis */}
          <div className="space-y-2">
            <Label htmlFor="diagnosis">
              Disease / Diagnosis <span className="text-destructive">*</span>
            </Label>
            <Input
              id="diagnosis"
              placeholder="e.g. Acute Appendicitis"
              value={diagnosis}
              onChange={(e) => setDiagnosis(e.target.value)}
              required
            />
          </div>

          {/* ICD Code */}
          <div className="space-y-2">
            <Label htmlFor="icd-code">ICD Code (optional)</Label>
            <Input
              id="icd-code"
              placeholder="e.g. K35.8"
              value={icdCode}
              onChange={(e) => {
                setIcdCode(e.target.value);
                setIcdError("");
              }}
            />
            {icdError && <p className="text-sm text-destructive">{icdError}</p>}
          </div>

          <Separator />

          {/* Generation Flags */}
          <div className="space-y-3">
            <Label>Sections to Generate</Label>
            <div className="space-y-4">
              {GENERATION_FLAGS.map(({ value, label }) => (
                <div key={value} className="space-y-2">
                  <div className="flex items-center space-x-2">
                    <Checkbox
                      id={`flag-${value}`}
                      checked={selectedFlags.has(value)}
                      onCheckedChange={() => toggleFlag(value)}
                    />
                    <Label
                      htmlFor={`flag-${value}`}
                      className="cursor-pointer font-normal"
                    >
                      {label}
                    </Label>
                  </div>

                  {/* Per-flag context input */}
                  {selectedFlags.has(value) && (
                    <div className="ml-6">
                      <Input
                        placeholder={`Additional context for ${label}...`}
                        value={flagContexts[value] || ""}
                        onChange={(e) =>
                          updateFlagContext(value, e.target.value)
                        }
                        className="text-sm"
                      />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          {selectedFlags.size === 0 && (
            <p className="text-sm text-muted-foreground">
              Select at least one section to generate.
            </p>
          )}

          <Separator />

          {/* General Context */}
          <div className="space-y-2">
            <Label htmlFor="general-context">General Context (optional)</Label>
            <Textarea
              id="general-context"
              placeholder="Additional context that applies to all generated sections..."
              value={generalContext}
              onChange={(e) => setGeneralContext(e.target.value)}
              rows={3}
            />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                resetForm();
                onOpenChange(false);
              }}
            >
              <X className="mr-2 h-4 w-4" />
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!diagnosis.trim() || selectedFlags.size === 0}
            >
              Generate Case
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
