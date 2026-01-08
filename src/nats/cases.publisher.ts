import { getJetStreamClient } from "./client.js";
import type { CaseGenerationResponse } from "../dtos/CaseGenerationResponse.js";
import type { Case } from "@/domain-models/Case.js";
import type { MsgHdrs } from "@nats-io/transport-node";

const SUBJECT = "cases.generated";

export async function publishCaseGenerationResponse(
  msgHeader: MsgHdrs | undefined,
  generatedCase: Case
) {
  const js = getJetStreamClient();

  // Map DTO to NATS format
  const response: CaseGenerationResponse = generatedCase;

  console.log(`[NATS] Publishing response ${msgHeader} case:`, response);

  if (msgHeader) {
    await js.publish(SUBJECT, JSON.stringify(response), {
      headers: msgHeader,
    });
  } else {
    await js.publish(SUBJECT, JSON.stringify(response));
  }
}
