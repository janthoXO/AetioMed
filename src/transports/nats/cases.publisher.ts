import { encodeCase } from "@/api/contentWire.js";
import type { GraphAppContext } from "@/core/graph/appContext.js";
import type {
  CaseGenerationResult,
  PlanPayload,
} from "@/core/caseGenerationService.js";
import { getJetStreamClient } from "./client.js";
import { planSubject, resultSubject } from "./subjects.js";

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

/**
 * Publish a job's plan into `CASE_PLANS` on its own subject (#159) — a
 * plan-mode call's result, or a normal-mode call's plan on the way. A job
 * has at most one plan, so `msgID` is keyed on the job alone.
 */
export async function publishPlan(plan: PlanPayload): Promise<void> {
  const js = getJetStreamClient();

  console.log(
    `[NATS] Publishing ${plan.mode}-mode plan for jobId=${plan.jobId}`
  );

  await js.publish(planSubject(plan.jobId), JSON.stringify(plan), {
    msgID: `plan-${plan.jobId}`,
  });
}

/**
 * Deliver the end of a call: a plan-mode stop goes to `cases.plan.<jobId>`,
 * a case or a failure to `cases.result.<jobId>`.
 */
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
