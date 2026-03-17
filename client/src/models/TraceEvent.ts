export type TraceEvent = {
  message: string;
  data?: any;
  timestamp: string;
  category?: "info" | "error" | "warning";
};