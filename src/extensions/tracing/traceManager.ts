import { EventEmitter } from "node:events";
import z from "zod";

export class TraceBus extends EventEmitter {}

export const TraceEventSchema = z.object({
  message: z.string(),
  data: z.any().optional(),
  timestamp: z.string().default(() => new Date().toISOString()),
  category: z.enum(["info", "error", "warn"]).default("info"),
});

export type TraceEvent = z.infer<typeof TraceEventSchema>;

const activeBuses = new Map<string, TraceBus>();

export function getTraceBus(traceId: string): TraceBus | undefined {
  return activeBuses.get(traceId);
}

export function setupTracing(traceId: string): {
  cleanup: () => void;
  bus: TraceBus; // return the bus directly
} {
  const bus = new TraceBus();
  activeBuses.set(traceId, bus);

  const cleanup = () => {
    // Wait a bit before cleaning up to ensure all events are sent
    setTimeout(() => {
      activeBuses.delete(traceId);
      bus.removeAllListeners();
    }, 10000);
  };

  return {
    cleanup,
    bus,
  };
}
