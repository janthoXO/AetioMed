import { useState, type FormEvent } from "react";
import { X, User, Stethoscope, ClipboardList, Activity } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { useCases } from "@/hooks/useCases";
import { useFeatures } from "@/hooks/useFeatures";
import type { GenerationFlag } from "@/models/GenerationFlags";
import { ICDCodePattern } from "@/models/Diagnosis";

const GENERATION_FLAGS: {
  value: GenerationFlag;
  label: string;
  description: string;
  icon: React.ElementType;
}[] = [
  {
    value: "patient",
    label: "Patient Info",
    description: "Demographics, age, weight, and general health status.",
    icon: User,
  },
  {
    value: "chiefComplaint",
    label: "Chief Complaint",
    description: "Primary problem and initial symptoms reported.",
    icon: Stethoscope,
  },
  {
    value: "anamnesis",
    label: "Anamnesis",
    description: "Detailed medical history and system review.",
    icon: ClipboardList,
  },
  {
    value: "procedures",
    label: "Procedures",
    description: "Recommended clinical tests and diagnostic actions.",
    icon: Activity,
  },
];

const ALL_FLAGS = new Set(GENERATION_FLAGS.map((f) => f.value));

import { LLMConfigForm } from "./LLMConfigForm";
import { useLLMConfig } from "@/hooks/useLLMConfig";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function GenerateCaseModal({ open, onOpenChange }: Props) {
  const { generateCase } = useCases();
  const { hasCustomLLM } = useFeatures();

  const [diagnosis, setDiagnosis] = useState("");
  const [icdCode, setIcdCode] = useState("");
  const [selectedFlags, setSelectedFlags] =
    useState<Set<GenerationFlag>>(ALL_FLAGS);
  const [flagContexts, setFlagContexts] = useState<
    Partial<Record<GenerationFlag, string>>
  >({});
  const [generalContext, setGeneralContext] = useState("");
  const [icdError, setIcdError] = useState("");

  const llmConfigState = useLLMConfig("llama3.1");

  function resetForm() {
    setDiagnosis("");
    setIcdCode("");
    setSelectedFlags(ALL_FLAGS);
    setFlagContexts({});
    setGeneralContext("");
    setIcdError("");
    llmConfigState.reset();
  }

  function toggleFlag(flag: GenerationFlag) {
    setSelectedFlags((prev) => {
      const next = new Set(prev);
      if (next.has(flag)) {
        next.delete(flag);
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

    if (icdCode && !ICDCodePattern.test(icdCode)) {
      setIcdError("Invalid format (e.g. A00, A00.0)");
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
      userInstructions: Object.keys(context).length > 0 ? context : undefined,
    };

    const llmConfig = llmConfigState.getLLMConfig();

    resetForm();
    onOpenChange(false);

    try {
      await generateCase(request, llmConfig);
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
      <DialogContent className="sm:max-w-137.5 max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-xl">Generate New Case</DialogTitle>
          <DialogDescription>
            Specify the diagnosis and configure the generation details.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-3 gap-4">
            <div className="space-y-2 col-span-2">
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
            <div className="space-y-2 col-span-1">
              <Label htmlFor="icd-code">ICD Code</Label>
              <Input
                id="icd-code"
                placeholder="e.g. K35.8"
                value={icdCode}
                onChange={(e) => {
                  setIcdCode(e.target.value);
                  setIcdError("");
                }}
              />
              {icdError && (
                <p className="text-xs text-destructive">{icdError}</p>
              )}
            </div>
          </div>

          <Accordion type="multiple" className="w-full">
            <AccordionItem value="sections">
              <AccordionTrigger className="text-base">
                Fields to Generate
              </AccordionTrigger>
              <AccordionContent className="space-y-4 px-1">
                <div className="flex justify-end">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="h-8 text-xs"
                    onClick={() => {
                      if (selectedFlags.size === GENERATION_FLAGS.length) {
                        setSelectedFlags(new Set());
                        setFlagContexts({});
                      } else {
                        setSelectedFlags(ALL_FLAGS);
                      }
                    }}
                  >
                    {selectedFlags.size === GENERATION_FLAGS.length
                      ? "Deselect All"
                      : "Select All"}
                  </Button>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {GENERATION_FLAGS.map(
                    ({ value, label, description, icon: Icon }) => {
                      const isSelected = selectedFlags.has(value);
                      return (
                        <div key={value} className="flex flex-col gap-3">
                          <Card
                            className={`cursor-pointer transition-colors relative flex-1 ${
                              isSelected
                                ? "border-primary ring-1 ring-primary bg-primary/5"
                                : "hover:bg-muted/50"
                            }`}
                            onClick={() => toggleFlag(value)}
                          >
                            <div className="p-2 flex flex-col gap-3 h-full">
                              <div className="flex items-center gap-2">
                                <div
                                  className={`p-2 w-10 h-10 rounded-lg flex items-center justify-center ${
                                    isSelected
                                      ? "bg-primary/20 text-primary"
                                      : "bg-muted text-muted-foreground"
                                  }`}
                                >
                                  <Icon className="h-5 w-5" />
                                </div>
                                <h3 className="font-medium leading-none mb-2">
                                  {label}
                                </h3>
                              </div>
                              <p className="text-xs text-muted-foreground leading-relaxed">
                                {description}
                              </p>
                            </div>
                          </Card>

                          {isSelected && (
                            <div className="animate-in fade-in zoom-in duration-200">
                              <Textarea
                                placeholder={`Custom instruction for ${label}...`}
                                value={flagContexts[value] || ""}
                                onChange={(e) =>
                                  updateFlagContext(value, e.target.value)
                                }
                                className="text-sm min-h-20 bg-background"
                              />
                            </div>
                          )}
                        </div>
                      );
                    }
                  )}
                </div>

                <div className="space-y-2">
                  <Label
                    htmlFor="general-context"
                    className="text-muted-foreground"
                  >
                    General Context (optional)
                  </Label>
                  <Textarea
                    id="general-context"
                    placeholder="Additional context that applies to all generated sections..."
                    value={generalContext}
                    onChange={(e) => setGeneralContext(e.target.value)}
                  />
                </div>

                {selectedFlags.size === 0 && (
                  <p className="text-sm text-warning">
                    Select at least one section to generate.
                  </p>
                )}
              </AccordionContent>
            </AccordionItem>

            {hasCustomLLM && (
              <AccordionItem value="llm">
                <AccordionTrigger className="text-base">
                  LLM Model Specification
                </AccordionTrigger>
                <AccordionContent className="space-y-4 pt-2 px-1">
                  <LLMConfigForm config={llmConfigState} size="sm" />
                </AccordionContent>
              </AccordionItem>
            )}
          </Accordion>

          <DialogFooter className="pt-2">
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
              disabled={
                !diagnosis.trim() ||
                selectedFlags.size === 0 ||
                (hasCustomLLM && !llmConfigState.model.trim())
              }
            >
              Generate Case
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
