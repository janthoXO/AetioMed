import { useState, useEffect } from "react";
import { config } from "@/config";

export function useFeatures() {
  const [features, setFeatures] = useState<string[]>([]);
  const [hasCustomLLM, setHasCustomLLM] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(true);

  useEffect(() => {
    async function fetchFeatures() {
      try {
        const response = await fetch(`${config.serverUrl}/features`);
        if (response.ok) {
          const data = await response.json();
          const featureList = data.features || [];
          setFeatures(featureList);
          setHasCustomLLM(featureList.includes("ALLOW_LLMS"));
        }
      } catch (error) {
        console.error("Failed to fetch features", error);
      } finally {
        setIsLoading(false);
      }
    }

    fetchFeatures();
  }, []);

  return { features, hasCustomLLM, isLoading };
}
