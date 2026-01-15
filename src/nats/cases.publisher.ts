import { getJetStreamClient } from "./client.js";
import type { CaseGenerationResponse } from "../dtos/CaseGenerationResponse.js";
import type { MsgHdrs } from "@nats-io/transport-node";

const SUBJECT = "cases.generated";

export async function publishCaseGenerationResponse(
  msgHeader: MsgHdrs | undefined,
  generatedCaseResponse: CaseGenerationResponse
) {
  const js = getJetStreamClient();

  console.log(`[NATS] Publishing response ${msgHeader} case:`, generatedCaseResponse);

  if (msgHeader) {
    await js.publish(SUBJECT, JSON.stringify(generatedCaseResponse), {
      headers: msgHeader,
    });
  } else {
    await js.publish(SUBJECT, JSON.stringify(generatedCaseResponse));
  }
}
