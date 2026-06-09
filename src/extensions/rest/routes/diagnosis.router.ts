import express from "express";
import { PredefinedDiagnoses } from "@/core/graph/models/Diagnosis.js";

const router = express.Router();

router.use((_req, _res, next) => {
  /* #swagger.tags = ['Diagnosis'] */
  next();
});

router.get("/", async (_, res) => {
  res.status(200).json(PredefinedDiagnoses);
});

export default router;
