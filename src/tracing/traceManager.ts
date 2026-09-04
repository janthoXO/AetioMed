import { EventEmitter } from "node:events";
import type { Language } from "@/core/graph/models/Language.js";

export class TraceBus extends EventEmitter {}

export interface TraceEvent {
  jobId: string;
  type: string;
  timestamp: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: any;
}

const activeBuses = new Map<string, TraceBus>();
/**
 * The request's language, per active job — set by `setupTracing` (called via
 * `registerJobHook`, see `utils/context.ts`) so trace-label localization
 * (`index.ts`'s `emitToTraceBus`) knows which language to translate into
 * without core ever carrying `language` on `RequestContext`.
 */
const jobLanguages = new Map<string, Language>();

export function getTraceBus(jobId: string): TraceBus | undefined {
  return activeBuses.get(jobId);
}

export function getJobLanguage(jobId: string): Language | undefined {
  return jobLanguages.get(jobId);
}

export function setupTracing(
  jobId: string,
  language?: Language
): {
  cleanup: () => void;
  bus: TraceBus;
} {
  const bus = new TraceBus();
  activeBuses.set(jobId, bus);
  if (language) jobLanguages.set(jobId, language);

  const cleanup = () => {
    // Wait a bit before cleaning up to ensure all events are sent
    setTimeout(() => {
      activeBuses.delete(jobId);
      jobLanguages.delete(jobId);
      bus.removeAllListeners();
    }, 10000);
  };

  return {
    cleanup,
    bus,
  };
}
