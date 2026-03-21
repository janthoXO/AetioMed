export type TraceEvent = {
  message: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data?: any;
  timestamp: string;
  category?: "info" | "error" | "warn";
};
