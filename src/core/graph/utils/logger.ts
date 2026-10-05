import type { EventBus } from "../../event-bus.js";
import type { Logger } from "../runtime.js";

/** Only caller of `bus.emit("Generation Log", ...)`; others use `runtime.log`. */
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
