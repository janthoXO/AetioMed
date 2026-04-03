import { EventEmitter } from "node:events";
import type { Case } from "@/core/models/Case.js";

export type GenerationCompletedEventPayload = {
  case: Case;
  additionalData?: object;
};

export type GenerationFailureEventPayload = {
  error: Error;
  additionalData?: object;
};

export type GenerationLogEventPayload = {
  msg: string;
  logLevel: "info" | "warn" | "error";
  timestamp: string;
  additionalData?: object;
};

export interface EventMap {
  "Generation Completed": GenerationCompletedEventPayload;
  "Generation Failure": GenerationFailureEventPayload;
  "Generation Log": GenerationLogEventPayload;
}

export class AppEventBus extends EventEmitter {
  public override emit<T extends keyof EventMap>(
    event: T,
    data: EventMap[T]
  ): boolean {
    return super.emit(event, data);
  }

  public override on<T extends keyof EventMap>(
    event: T,
    listener: (data: EventMap[T]) => void
  ): this {
    return super.on(event, listener);
  }

  public override off<K extends keyof EventMap>(
    event: K,
    listener: (data: EventMap[K]) => void
  ): this {
    return super.off(event, listener);
  }
}

export const eventBus = new AppEventBus();

export function publishEvent<T extends keyof EventMap>(
  event: T,
  data: EventMap[T]
): void {
  eventBus.emit(event, data);
}
