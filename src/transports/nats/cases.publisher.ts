import { encodeCase } from "@/api/contentWire.js";
import type { GraphAppContext } from "@/core/graph/appContext.js";
import type {
  CaseGenerationResult,
  PlanPayload,
} from "@/core/caseGenerationService.js";
import { getJetStreamClient } from "./client.js";
import { planSubject, resultSubject } from "./subjects.js";

/** Publish result to `cases.result.<jobId>`. `msgID` dedupes redelivered job's second result. */
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

/** Publish plan to `cases.plan.<jobId>`. One plan per job, so `msgID` keyed on job alone. */
export async function publishPlan(plan: PlanPayload): Promise<void> {
  const js = getJetStreamClient();

  console.log(
    `[NATS] Publishing ${plan.mode}-mode plan for jobId=${plan.jobId}`
  );

  await js.publish(planSubject(plan.jobId), JSON.stringify(plan), {
    msgID: `plan-${plan.jobId}`,
  });
}

/** Deliver call outcome: plan to `cases.plan.<jobId>`, case/failure to `cases.result.<jobId>`. */
export async function publishStop(
  graph: GraphAppContext,
  result: CaseGenerationResult
): Promise<void> {
  if (result.status === "planned") {
    await publishPlan({
      jobId: result.jobId,
      mode: "plan",
      language: result.language!,
      plan: result.plan!,
    });
    return;
  }
  if (result.status === "done") {
    await publishCaseResult(result.jobId, {
      ...encodeCase(result.case!, graph.config.MAX_CONTENT_PART_BYTES),
      language: result.language,
    });
    return;
  }
  await publishCaseResult(result.jobId, {
    error: {
      code: result.error!.code,
      message: result.error!.message,
      details: result.error!.details,
    },
  });
}
