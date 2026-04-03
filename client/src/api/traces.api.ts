import { config } from "@/config";
import type { TraceEvent } from "@/models/TraceEvent";

export async function fetchTraceHistory(
  traceId: string
): Promise<{ traces: TraceEvent[]; warning?: string }> {
  const features = await fetch(`${config.serverUrl}/features`)
    .then((res) => res.json())
    .then((data) => data.features);
  if (!features.includes("PERSISTENCY")) {
    return {
      traces: [],
      warning:
        "Persistency is not enabled. Only live events are being displayed.",
    };
  }

  const historyUrl = `${config.serverUrl}/traces/${traceId}`;
  const response = await fetch(historyUrl);

  if (response.status === 404) {
    return { traces: [] };
  }

  if (response.ok) {
    const data = await response.json();
    return { traces: data.traces || [] };
  }

  throw new Error("Failed to fetch trace history");
}

export function createTraceEventSource(traceId: string) {
  const sseUrl = `${config.serverUrl}/traces/${traceId}/stream`;
  return new EventSource(sseUrl);
}
