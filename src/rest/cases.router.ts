import express from "express";
import { generateCase } from "../services/cases.service.js";
import { CaseGenerationRequestSchema } from "../dtos/CaseGenerationRequest.js";
import { CaseGenerationResponseSchema } from "../dtos/CaseGenerationResponse.js";
import { flagStringsToBitmap } from "../domain-models/GenerationFlags.js";

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

  const { diagnosis, context, generationFlags } = bodyResult.data;
  const flagsBitmap = flagStringsToBitmap(generationFlags);

  try {
    const caseData = await generateCase(flagsBitmap, diagnosis, context);
    const response = CaseGenerationResponseSchema.parse(caseData);
    res.status(200).json(response);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Internal server error" });
  }
});

export default router;
