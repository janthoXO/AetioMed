import express from "express";
import { generateCase } from "../services/cases.service.js";
import { CaseGenerationRequestSchema } from "../dtos/CaseGenerationRequest.js";
import { CaseGenerationResponseSchema } from "../dtos/CaseGenerationResponse.js";
import { IcdToDiseaseName } from "@/services/diseases.service.js";

const router = express.Router();

router.use((_req, _res, next) => {
  /* #swagger.tags = ['Cases'] */
  next();
});

router.post("/", async (req, res) => {
  // take Case Generation Request from body
  const bodyResult = CaseGenerationRequestSchema.safeParse(req.body);

  if (!bodyResult.success) {
    res.status(400).json({
      message: "Invalid request body",
      errors: bodyResult.error.issues,
    });
    return;
  }

  let { diagnosis } = bodyResult.data;
  const { icd, context, generationFlags } = bodyResult.data;

  // fill diagnosis and icdCode - zod makes sure that at least one is filled
  if (!diagnosis) {
    // if diagnosis is missing, icd is provided
    diagnosis = await IcdToDiseaseName(icd!);
    // verify that is set now, otherwise return error
    if (!diagnosis) {
      res.status(400).json({ message: "No diagnosis found for icd" });
      return;
    }
  }

  try {
    const caseData = await generateCase(
      icd,
      diagnosis,
      context,
      generationFlags
    );
    const response = CaseGenerationResponseSchema.parse(caseData);
    res.status(200).json(response);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Internal server error" });
  }
});

export default router;
