import { getJetStreamClient } from "./client.js";
import { headers } from "@nats-io/transport-node";

const SUBJECT = "cases.generated";

export async function publishCaseGenerationResponse(
  jobId: string,
  response: Record<string, unknown>
): Promise<void> {
  const js = getJetStreamClient();
  const hdrs = headers();
  hdrs.set("Nats-Msg-Id", `generated-${jobId}`);

  const payload = { jobId, ...response };

  console.log(`[NATS] Publishing response for jobId=${jobId}:`, payload);

  await js.publish(SUBJECT, JSON.stringify(payload), { headers: hdrs });
}
