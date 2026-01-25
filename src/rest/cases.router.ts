import express from "express";
import { generateCase } from "../services/cases.service.js";
import {
  CaseGenerationRequestSchema,
  type CaseGenerationRequest,
} from "../dtos/CaseGenerationRequest.js";
import {
  CaseGenerationResponseSchema,
  type CaseGenerationResponse,
} from "../dtos/CaseGenerationResponse.js";
import { IcdToDiseaseName } from "@/services/diseases.service.js";
import { AppError } from "@/errors/AppError.js";
import {
  translateAnamnesisCategoriesFromEnglish,
  translateAnamnesisCategoriesToEnglish,
} from "@/services/anamnesis.service.js";

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
    const { icd, context, generationFlags, language } = bodyResult.data;

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

    try {
      const caseData = await generateCase(
        icd,
        diagnosis,
        generationFlags,
        context,
        language
      );
      const response = CaseGenerationResponseSchema.parse(caseData);

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

export default router;
