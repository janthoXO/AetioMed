import express from "express";
import type { GraphAppContext } from "@/core/graph/appContext.js";

export default function createDiagnosisRouter(graph: GraphAppContext) {
  const router = express.Router();

  router.use((_req, _res, next) => {
    /* #swagger.tags = ['Diagnosis'] */
    next();
  });

  router.get("/", async (_, res) => {
    res.status(200).json(graph.runtime.catalogs.diagnosis.all());
  });

  return router;
}
