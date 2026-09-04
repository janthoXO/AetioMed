import express from "express";
import { makeCaseGenerationRequestSchema } from "@/extensions/api/CaseGenerationRequest.js";
import type { CaseGenerationRequest } from "@/extensions/api/CaseGenerationRequest.js";
import {
  CaseGenerationResponseSchema,
  type CaseGenerationResponse,
} from "@/extensions/api/CaseGenerationResponse.js";
import { AppError } from "@/core/graph/errors/AppError.js";
import { runWithContext } from "@/core/graph/utils/context.js";
import * as cancelManager from "@/core/graph/utils/cancelManager.js";
import type { GraphAppContext } from "@/core/graph/appContext.js";
import type { EventBus } from "@/core/event-bus.js";

export default function createCasesRouter(
  graph: GraphAppContext,
  bus: EventBus
) {
  const router = express.Router();
  const CaseGenerationRequestSchema = makeCaseGenerationRequestSchema(
    graph.config
  );

  router.use((_req, _res, next) => {
    /* #swagger.tags = ['Cases'] */
    next();
  });

  router.post(
    "/",
    async (
      req: express.Request<CaseGenerationRequest>,
      res: express.Response<CaseGenerationResponse>
    ) => {
      /*  #swagger.requestBody = {
              required: true,
              content: {
                  "application/json": {
                      schema: {
                          $ref: "#/components/schemas/CaseGenerationRequest"
                      }
                  }
              }
          }
      */
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

      let { diagnosis } = bodyResult.data;
      const {
        icd,
        userInstructions,
        generationFlags,
        language,
        difficulty,
        llmConfig,
      } = bodyResult.data;

      if (!diagnosis) {
        diagnosis = graph.runtime.catalogs.diagnosis.byIcd(icd!)?.name;
        if (!diagnosis) {
          res.status(400).json({
            error: {
              code: "INVALID_REQUEST_BODY",
              message: "No diagnosis found for icd",
            },
          });
          return;
        }
      }

      const jobId = (req.query.jobId as string) ?? crypto.randomUUID();

      // Abort generation when the HTTP client disconnects before completion
      res.on("close", () => {
        if (!res.writableFinished) {
          cancelManager.abort(jobId);
        }
      });

      try {
        const caseData = await runWithContext(
          () =>
            graph.generateCase(
              { name: diagnosis, icd },
              generationFlags,
              userInstructions,
              language,
              difficulty
            ),
          jobId,
          llmConfig
        );

        bus.emit("Generation Completed", { case: caseData, jobId });

        const response = CaseGenerationResponseSchema.parse({
          ...caseData,
          jobId,
        });

        /* #swagger.responses[200] = {
              content: {
                  "application/json": {
                      schema:{
                          $ref: "#/components/schemas/CaseGenerationResponse"
                      }
                  }
              }
          }
      */
        res.status(200).json(response);
      } catch (error) {
        console.error(error);

        if (error instanceof Error && error.name === "AbortError") {
          bus.emit("Generation Cancelled", { jobId });
          if (!res.writableEnded) {
            res.status(499).end();
          }
          return;
        }

        if (error instanceof Error) {
          bus.emit("Generation Failure", { error, jobId });
        }
        if (error instanceof AppError) {
          res.status(error.statusCode).json({
            error: {
              code: error.code,
              message: error.message,
              details: error.details,
            },
          });
          return;
        }

        res.status(500).json({
          error: {
            code: "INTERNAL_SERVER_ERROR",
            message: "Internal server error",
          },
        });
      }
    }
  );

  router.delete("/:jobId", (req, res) => {
    const { jobId } = req.params;
    const aborted = cancelManager.abort(jobId);
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
