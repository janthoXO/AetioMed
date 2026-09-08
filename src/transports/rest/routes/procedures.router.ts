import express from "express";
import type { GraphAppContext } from "@/core/graph/appContext.js";

export default function createProceduresRouter(graph: GraphAppContext) {
  const router = express.Router();

  router.use((_req, _res, next) => {
    /* #swagger.tags = ['Procedures'] */
    next();
  });

  router.get("/", async (_, res) => {
    res
      .status(200)
      .json(
        graph.runtime.catalogs.procedures.list()?.map((p) => ({ name: p }))
      );
  });

  return router;
}
