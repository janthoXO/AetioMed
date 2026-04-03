import { PredefinedDiagnoses } from "@/core/models/Diagnosis.js";
import express from "express";

const router = express.Router();

router.use((_req, _res, next) => {
  /* #swagger.tags = ['Diseases'] */
  next();
});

router.get("/", async (_, res) => {
  res.status(200).json(PredefinedDiagnoses);
});

export default router;
