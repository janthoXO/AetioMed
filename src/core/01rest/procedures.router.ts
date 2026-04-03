import express from "express";
import { PredefinedProcedureNames } from "@/core/models/Procedure.js";

const router = express.Router();

router.use((_req, _res, next) => {
  /* #swagger.tags = ['Procedures'] */
  next();
});

router.get("/", async (_, res) => {
  res.status(200).json(PredefinedProcedureNames);
});

export default router;
