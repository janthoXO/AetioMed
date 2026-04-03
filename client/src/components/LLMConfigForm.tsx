import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import type { LLMProvider } from "@/models/Case";
import { useLLMConfig } from "@/hooks/useLLMConfig";
import { useAllowedLlms } from "@/hooks/useAllowedLlms";
import { useEffect } from "react";

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

  const { allowedLlms, fetchAllowedLlms, isLoading } = useAllowedLlms();

  useEffect(() => {
    fetchAllowedLlms();
  }, [fetchAllowedLlms]);

  useEffect(() => {
    if (allowedLlms && provider && allowedLlms[provider]) {
      const allowedModels = allowedLlms[provider];
      if (allowedModels.length > 0 && !allowedModels.includes(model)) {
        setModel(allowedModels[0]);
      }
    }
  }, [provider, allowedLlms, model, setModel]);

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
          disabled={isLoading}
        >
          {(allowedLlms ? Object.keys(allowedLlms) : ["ollama", "google"]).map(
            (p) => (
              <option key={p} value={p}>
                {p.charAt(0).toUpperCase() + p.slice(1)}
              </option>
            )
          )}
        </select>
      </div>

      <div className="space-y-2">
        <Label className={labelClass}>
          Model <span className="text-destructive">*</span>
        </Label>
        {allowedLlms &&
        allowedLlms[provider] &&
        allowedLlms[provider].length > 0 ? (
          <select
            className={`flex w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 ${inputClass}`}
            value={model}
            onChange={(e) => setModel(e.target.value)}
            required
            disabled={isLoading}
          >
            {allowedLlms[provider].map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        ) : (
          <Input
            placeholder="e.g. llama3.1"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            required
            className={inputClass}
            disabled={isLoading}
          />
        )}
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
