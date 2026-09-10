import type express from "express";

export interface SseStream {
  /** Write one `event: <type>` frame. A no-op once the stream has ended. */
  event(type: string, data: unknown): void;
  /**
   * Write an SSE comment frame (`: <text>`). Every SSE client ignores
   * comments, which is what makes them a heartbeat that carries nothing.
   */
  comment(text: string): void;
  /** End the stream. Idempotent. */
  end(): void;
}

/**
 * Switch `res` to `text/event-stream`. Every REST stream (the job label
 * stream, and the POST stream in #143) goes through here, so the framing
 * lives in one place.
 */
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
