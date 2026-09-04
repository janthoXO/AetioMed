import type { EventBus } from "../../event-bus.js";
import type { Logger } from "../runtime.js";

/**
 * The one place `bus.emit("Generation Log", ...)` is called from. Every
 * other call site goes through `runtime.log.info/warn/error` instead.
 */
export function createLogger(
  bus: EventBus,
  clock: () => Date = () => new Date()
): Logger {
  function emit(msg: string, logLevel: "info" | "warn" | "error") {
    bus.emit("Generation Log", {
      msg,
      logLevel,
      timestamp: clock().toISOString(),
    });
  }

  return {
    info(msg: string) {
      emit(msg, "info");
    },
    warn(msg: string) {
      emit(msg, "warn");
    },
    error(msg: string) {
      emit(msg, "error");
    },
  };
}
