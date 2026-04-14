import express from "express";
import casesRouter from "./cases.router.js";
import diseasesRouter from "./diseases.router.js";
import proceduresRouter from "./procedures.router.js";
import { config } from "../index.js";

const router = express.Router();
router.use("/cases", casesRouter);
router.use("/diseases", diseasesRouter);
router.use("/procedures", proceduresRouter);

router.get("/allowedLlms", (_req, res) => {
  return res.json(config.allowedLlms || []);
});

export default router;
