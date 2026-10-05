import { z } from "zod/v4";

/**
 * Client-supplied job id. Idempotency key and, on NATS, subject token
 * (`cases.result.<jobId>`): no `.`, `*`, `>` or whitespace. UUID fits.
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
