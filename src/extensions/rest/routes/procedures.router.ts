import express from "express";
import { PredefinedProcedureNames } from "@/core/graph/03repo/procedures.repo.js";

const router = express.Router();

router.use((_req, _res, next) => {
  /* #swagger.tags = ['Procedures'] */
  next();
});

router.get("/", async (_, res) => {
  res.status(200).json(PredefinedProcedureNames?.map((p) => ({ name: p })));
});

export default router;
