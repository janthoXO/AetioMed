import express from "express";
import { PredefinedProcedures } from "@/models/Procedure.js";

const router = express.Router();

router.use((_req, _res, next) => {
  /* #swagger.tags = ['Procedures'] */
  next();
});

router.get("/", async (_, res) => {
  res.status(200).json(PredefinedProcedures);
});

export default router;
