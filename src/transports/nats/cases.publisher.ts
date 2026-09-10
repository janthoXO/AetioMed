import { getJetStreamClient } from "./client.js";
import { resultSubject } from "./subjects.js";

/**
 * Publish a job's result into `CASE_RESULTS` on its own subject. The
 * `msgID` makes a redelivered job's second result a no-op within the
 * stream's duplicate window.
 */
export async function publishCaseResult(
  jobId: string,
  response: Record<string, unknown>
): Promise<void> {
  const js = getJetStreamClient();
  const payload = { jobId, ...response };

  console.log(`[NATS] Publishing result for jobId=${jobId}`);

  await js.publish(resultSubject(jobId), JSON.stringify(payload), {
    msgID: `result-${jobId}`,
  });
}
