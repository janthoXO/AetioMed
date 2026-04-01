import express from "express";
import { generateCase } from "@/02services/cases.service.js";
import {
  CaseGenerationRequestSchema,
  type CaseGenerationRequest,
} from "@/01dtos/CaseGenerationRequest.js";
import {
  CaseGenerationResponseSchema,
  type CaseGenerationResponse,
} from "@/01dtos/CaseGenerationResponse.js";
import { IcdToDiseaseName } from "@/03repo/diseases.repo.js";
import { AppError } from "@/errors/AppError.js";
import {
  translateAnamnesisCategoriesFromEnglish,
  translateAnamnesisCategoriesToEnglish,
} from "@/02services/anamnesis.service.js";
import { getTraceBus } from "@/utils/traceManager.js";
import { runWithContext } from "@/utils/context.js";
import { getRedisClient } from "@/utils/redis.js";

const router = express.Router();

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
    const { icd, userInstructions, generationFlags, language } =
      bodyResult.data;

    // fill diagnosis and icdCode - zod makes sure that at least one is filled
    if (!diagnosis) {
      // if diagnosis is missing, icd is provided
      diagnosis = await IcdToDiseaseName(icd!);
      // verify that is set now, otherwise return error
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

    const traceId = bodyResult.data.traceId ?? crypto.randomUUID();

    try {
      const caseData = await runWithContext(
        () =>
          generateCase(
            {
              name: diagnosis!,
              icd: icd,
            },
            generationFlags,
            userInstructions,
            language
          ),
        traceId,
        bodyResult.data.llmConfig
      );
      const response = CaseGenerationResponseSchema.parse({
        ...caseData,
        traceId: traceId,
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

router.get("/anamnesis/translate", async (req, res) => {
  const { categories, language } = req.body;

  try {
    const englishTranslation = await translateAnamnesisCategoriesToEnglish(
      categories,
      language
    );

    const backToForeign = await translateAnamnesisCategoriesFromEnglish(
      Object.values(englishTranslation),
      language
    );

    res
      .status(200)
      .json({ ToEnglish: englishTranslation, ToForeign: backToForeign });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: `Internal server error: ${error}`,
      },
    });
  }
});

router.get("/traces/:traceId/stream", (req, res) => {
  const { traceId } = req.params;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders(); // flush the headers to establish SSE

  const bus = getTraceBus(traceId);

  if (!bus) {
    // If bus not found (maybe finished or invalid), just close the stream
    res.write("event: complete\ndata: {}\n\n");
    res.end();
    return;
  }

  // Send an initial connected ping
  res.write("event: connected\ndata: {}\n\n");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const onTrace = (data: any) => {
    res.write(`event: trace\ndata: ${JSON.stringify(data)}\n\n`);
  };

  bus.on("trace", onTrace);

  req.on("close", () => {
    bus.off("trace", onTrace);
  });
});

router.get("/traces/:traceId", async (req, res) => {
  const { traceId } = req.params;
  const redis = await getRedisClient();

  if (!redis) {
    res.status(404).json({
      error: {
        code: "REDIS_DISABLED",
        message: "Redis is not configured. Trace history is unavailable.",
      },
    });
    return;
  }

  try {
    const key = `traces:${traceId}`;
    const rawTraces = await redis.lRange(key, 0, -1);
    const traces = rawTraces.map((t) => JSON.parse(t));
    res.status(200).json({ traces });
  } catch (err) {
    console.error(`[Redis] Failed to fetch traces for ${traceId}`, err);
    res.status(500).json({
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to fetch trace history",
      },
      traces: [],
    });
  }
});

export default router;
