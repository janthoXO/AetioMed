import type express from "express";

export interface SseStream {
  /** Write one `event: <type>` frame. No-op after end. */
  event(type: string, data: unknown): void;
  /** Write SSE comment frame (`: <text>`); clients ignore it, so it works as heartbeat. */
  comment(text: string): void;
  /** End the stream. Idempotent. */
  end(): void;
}

/** Switch `res` to `text/event-stream`. All REST streams go through here. */
export function openSse(res: express.Response): SseStream {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  return {
    event(type, data) {
      if (res.writableEnded) return;
      res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    comment(text) {
      if (res.writableEnded) return;
      res.write(`: ${text}\n\n`);
    },
    end() {
      if (!res.writableEnded) res.end();
    },
  };
}
