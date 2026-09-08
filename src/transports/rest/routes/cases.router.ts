import express from "express";
import { makeCaseGenerationRequestSchema } from "@/api/index.js";
import { CaseGenerationResponseSchema } from "@/api/index.js";
import type { GraphAppContext } from "@/core/graph/appContext.js";
import type { CaseGenerationService } from "@/core/caseGenerationService.js";

export default function createCasesRouter(
  graph: GraphAppContext,
  service: CaseGenerationService
) {
  const router = express.Router();
  const CaseGenerationRequestSchema = makeCaseGenerationRequestSchema(
    graph.config
  );

  router.post("/", async (req: express.Request, res: express.Response) => {
    const bodyResult = CaseGenerationRequestSchema.safeParse(req.body);

    if (!bodyResult.success) {
      console.error("Invalid request body", req.body);
      res.status(400).json({
        error: {
          code: "INVALID_REQUEST_BODY",
          message: "Invalid request body",
          details: JSON.stringify(bodyResult.error.issues),
        },
      });
      return;
    }

    const jobId = (req.query.jobId as string) ?? crypto.randomUUID();

    // Abort generation when the HTTP client disconnects before completion
    res.on("close", () => {
      if (!res.writableFinished) {
        service.cancel(jobId);
      }
    });

    const result = await service.generate({ ...bodyResult.data, jobId });

    if (result.status === "done") {
      const response = CaseGenerationResponseSchema.parse({
        ...result.case,
        jobId: result.jobId,
      });
      res.status(200).json(response);
      return;
    }

    const error = result.error!;
    if (res.writableEnded) return;

    if (error.code === "GENERATION_CANCELLED") {
      res.status(error.statusCode ?? 499).end();
      return;
    }

    res.status(error.statusCode ?? 500).json({
      error: {
        code: error.code,
        message: error.message,
        details: error.details,
      },
    });
  });

  router.delete("/:jobId", (req, res) => {
    const { jobId } = req.params;
    const aborted = service.cancel(jobId);
    if (aborted) {
      res.status(204).end();
    } else {
      res.status(404).json({
        error: {
          code: "NOT_FOUND",
          message: "No active generation for this jobId",
        },
      });
    }
  });

  return router;
}
