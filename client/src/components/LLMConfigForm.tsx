import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import type { LLMProvider } from "@/models/Case";
import { useLLMConfig } from "@/hooks/useLLMConfig";

export interface LLMConfigFormProps {
  config: ReturnType<typeof useLLMConfig>;
  size?: "sm" | "default";
}

export function LLMConfigForm({
  config,
  size = "default",
}: LLMConfigFormProps) {
  const {
    provider,
    setProvider,
    model,
    setModel,
    apiKey,
    setApiKey,
    url,
    setUrl,
  } = config;

  const labelClass = size === "sm" ? "text-xs" : "text-sm font-medium";
  const inputClass = size === "sm" ? "h-9" : "h-10";

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label className={labelClass}>Provider</Label>
        <select
          className={`flex w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 ${inputClass}`}
          value={provider}
          onChange={(e) => setProvider(e.target.value as LLMProvider)}
        >
          <option value="ollama">Ollama</option>
          <option value="google">Google</option>
        </select>
      </div>

      <div className="space-y-2">
        <Label className={labelClass}>
          Model <span className="text-destructive">*</span>
        </Label>
        <Input
          placeholder="e.g. llama3.1"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          required
          className={inputClass}
        />
      </div>

      <div className="space-y-2">
        <Label className={labelClass}>API Key (optional)</Label>
        <Input
          type="password"
          placeholder="Leave blank if not needed"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          className={inputClass}
        />
      </div>

      <div className="space-y-2">
        <Label className={labelClass}>API URL (optional)</Label>
        <Input
          type="url"
          placeholder="e.g. http://localhost:11434"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          className={inputClass}
        />
      </div>
    </div>
  );
}
