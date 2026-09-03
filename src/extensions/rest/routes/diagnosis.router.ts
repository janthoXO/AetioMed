import express from "express";
import { getAllDiagnoses } from "@/core/graph/03repo/diagnosis.repo.js";

const router = express.Router();

router.use((_req, _res, next) => {
  /* #swagger.tags = ['Diagnosis'] */
  next();
});

router.get("/", async (_, res) => {
  res.status(200).json(getAllDiagnoses());
});

export default router;
