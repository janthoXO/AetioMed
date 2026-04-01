import { useState, type FormEvent } from "react";
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
import type { LLMConfig, LLMProvider } from "@/models/Case";

const GENERATION_FLAGS: { value: GenerationFlag; label: string }[] = [
  { value: "patient", label: "Patient" },
  { value: "chiefComplaint", label: "Chief Complaint" },
  { value: "anamnesis", label: "Anamnesis" },
  { value: "procedures", label: "Procedures" },
];

const ALL_FLAGS = new Set(GENERATION_FLAGS.map((f) => f.value));

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

  const [llmProvider, setLLMProvider] = useState<LLMProvider>("ollama");
  const [llmModel, setLLMModel] = useState("llama3.1");
  const [llmApiKey, setLLMApiKey] = useState("");
  const [llmUrl, setLLMUrl] = useState("");

  function resetForm() {
    setDiagnosis("");
    setIcdCode("");
    setSelectedFlags(ALL_FLAGS);
    setFlagContexts({});
    setGeneralContext("");
    setIcdError("");
    setLLMProvider("ollama");
    setLLMModel("llama3.1");
    setLLMApiKey("");
    setLLMUrl("");
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
      context: Object.keys(context).length > 0 ? context : undefined,
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
              <AccordionContent className="space-y-4 pt-2 px-1">
                <div className="space-y-2">
                  <div className="flex flex-row justify-between">
                    <Label
                      htmlFor="general-context"
                      className="text-muted-foreground"
                    >
                      General Context (optional)
                    </Label>
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
                  <Textarea
                    id="general-context"
                    placeholder="Additional context that applies to all generated sections..."
                    value={generalContext}
                    onChange={(e) => setGeneralContext(e.target.value)}
                  />
                </div>

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

                      {selectedFlags.has(value) && (
                        <div className="ml-6">
                          <Textarea
                            placeholder={`Additional context for ${label}...`}
                            value={flagContexts[value] || ""}
                            onChange={(e) =>
                              updateFlagContext(value, e.target.value)
                            }
                            className="text-sm h-8"
                          />
                        </div>
                      )}
                    </div>
                  ))}
                </div>

                {selectedFlags.size === 0 && (
                  <p className="text-sm text-muted-foreground">
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
                  <div className="space-y-4">
                    <div className="space-y-2">
                      <Label className="text-xs">Provider</Label>
                      <select
                        className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                        value={llmProvider}
                        onChange={(e) =>
                          setLLMProvider(e.target.value as LLMProvider)
                        }
                      >
                        <option value="ollama">Ollama</option>
                        <option value="google">Google</option>
                      </select>
                    </div>

                    <div className="space-y-2">
                      <Label className="text-xs">
                        Model <span className="text-destructive">*</span>
                      </Label>
                      <Input
                        placeholder="e.g. llama3.1"
                        value={llmModel}
                        onChange={(e) => setLLMModel(e.target.value)}
                        required
                        className="h-9"
                      />
                    </div>

                    <div className="space-y-2">
                      <Label className="text-xs">API Key (optional)</Label>
                      <Input
                        type="password"
                        placeholder="Leave blank if not needed"
                        value={llmApiKey}
                        onChange={(e) => setLLMApiKey(e.target.value)}
                        className="h-9"
                      />
                    </div>

                    <div className="space-y-2">
                      <Label className="text-xs">API URL (optional)</Label>
                      <Input
                        type="url"
                        placeholder="e.g. http://localhost:11434"
                        value={llmUrl}
                        onChange={(e) => setLLMUrl(e.target.value)}
                        className="h-9"
                      />
                    </div>
                  </div>
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
                !llmModel.trim()
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
