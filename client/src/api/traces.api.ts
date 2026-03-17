import { config } from "@/config";
import type { TraceEvent } from "@/models/TraceEvent";

export async function fetchTraceHistory(
  caseId: string
): Promise<{ traces: TraceEvent[]; warning?: string }> {
  const historyUrl = `${config.generationUrl}/${caseId}/traces`;
  const response = await fetch(historyUrl);

  if (response.status === 404) {
    const data = await response.json();
    if (data.error?.code === "REDIS_DISABLED") {
      return {
        traces: [],
        warning: "Redis is not enabled. Only live events are being displayed.",
      };
    }
    return { traces: [] };
  } else if (response.ok) {
    const data = await response.json();
    return { traces: data.traces || [] };
  }

  throw new Error("Failed to fetch trace history");
}

export function createTraceEventSource(caseId: string) {
  const sseUrl = `${config.generationUrl}/${caseId}/traces/stream`;
  return new EventSource(sseUrl);
}
