import { EventEmitter } from "node:events";

export class TraceBus extends EventEmitter {}

export interface TraceEvent {
  jobId: string;
  type: string;
  timestamp: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: any;
}

const activeBuses = new Map<string, TraceBus>();

export function getTraceBus(jobId: string): TraceBus | undefined {
  return activeBuses.get(jobId);
}

export function setupTracing(jobId: string): {
  cleanup: () => void;
  bus: TraceBus;
} {
  const bus = new TraceBus();
  activeBuses.set(jobId, bus);

  const cleanup = () => {
    // Wait a bit before cleaning up to ensure all events are sent
    setTimeout(() => {
      activeBuses.delete(jobId);
      bus.removeAllListeners();
    }, 10000);
  };

  return {
    cleanup,
    bus,
  };
}
