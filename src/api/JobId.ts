import { z } from "zod/v4";

/**
 * A client-supplied job id. It is an idempotency key (a duplicate never
 * starts a second generation) and, on NATS, a subject token
 * (`cases.result.<jobId>`), so it must not contain `.`, `*`, `>` or
 * whitespace — any of those would silently address a different subject.
 * A UUID fits.
 */
export const JobIdSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9_-]{1,128}$/,
    "jobId must be 1-128 characters of A-Z, a-z, 0-9, '_' or '-'"
  )
  .describe(
    "Client-chosen job id (e.g. a UUID). Reusing the id of a running or recently finished job is rejected."
  );
