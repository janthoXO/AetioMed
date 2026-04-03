import { useState } from "react";
import { config } from "@/config";

export function useAllowedLlms() {
  const [allowedLlms, setAllowedLlms] = useState<Record<
    string,
    string[]
  > | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  async function fetchAllowedLlms() {
    try {
      const response = await fetch(`${config.serverUrl}/allowedLlms`);
      if (response.ok) {
        const data = await response.json();
        setAllowedLlms(data);
      }
    } catch (error) {
      console.error("Failed to fetch allowed LLMs:", error);
    } finally {
      setIsLoading(false);
    }
  }

  return { allowedLlms, fetchAllowedLlms, isLoading };
}
