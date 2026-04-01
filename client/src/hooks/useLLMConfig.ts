import { useState } from "react";
import type { LLMConfig, LLMProvider } from "@/models/Case";

export function useLLMConfig(defaultModel = "llama3.1") {
  const [provider, setProvider] = useState<LLMProvider>("ollama");
  const [model, setModel] = useState(defaultModel);
  const [apiKey, setApiKey] = useState("");
  const [url, setUrl] = useState("");

  const reset = () => {
    setProvider("ollama");
    setModel(defaultModel);
    setApiKey("");
    setUrl("");
  };

  const getLLMConfig = (): LLMConfig | undefined => {
    if (!model) return undefined;
    return {
      provider,
      model,
      ...(apiKey ? { apiKey } : {}),
      ...(url ? { url } : {}),
    };
  };

  return {
    provider,
    setProvider,
    model,
    setModel,
    apiKey,
    setApiKey,
    url,
    setUrl,
    reset,
    getLLMConfig,
  };
}
