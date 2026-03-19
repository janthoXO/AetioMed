import { useEffect, useState } from "react";
import { fetchTraceHistory, createTraceEventSource } from "@/api/traces.api";
import type { TraceEvent } from "@/models/TraceEvent";

export function useTraces(caseId: string, isCompleted: boolean) {
  const [traces, setTraces] = useState<TraceEvent[]>([]);
  const [warning, setWarning] = useState<string | null>(null);

  useEffect(() => {
    let eventSource: EventSource | null = null;
    let isMounted = true;

    async function loadTraces() {
      try {
        const result = await fetchTraceHistory(caseId);
        if (!isMounted) return;

        if (result.warning) {
          setWarning(result.warning);
        }
        if (result.traces && result.traces.length > 0) {
          setTraces(result.traces);
        }
      } catch (err) {
        console.error("Failed to fetch trace history", err);
      }

      if (isCompleted || !isMounted) return;

      eventSource = createTraceEventSource(caseId);

      eventSource.addEventListener("trace", (event) => {
        try {
          const data: TraceEvent = JSON.parse(event.data);
          setTraces((prev) => [...prev, data]);
        } catch (err) {
          console.error("Failed to parse trace event", err);
        }
      });

      eventSource.addEventListener("complete", () => {
        eventSource?.close();
      });

      eventSource.onerror = (err) => {
        console.error("EventSource failed:", err);
        eventSource?.close();
      };
    }

    loadTraces();

    return () => {
      isMounted = false;
      if (eventSource) {
        eventSource.close();
      }
    };
  }, [caseId, isCompleted]);

  return { traces, warning };
}
