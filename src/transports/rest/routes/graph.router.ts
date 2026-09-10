import express from "express";
import type { ReadModel } from "@/core/readModel.js";

/** `GET /api/graph` — the compiled topology labels are keyed against. */
export default function createGraphRouter(
  readModel: ReadModel
): express.Router {
  const router = express.Router();

  router.get("/graph", (_req, res) => {
    readModel
      .graph()
      .then((structure) => res.json(structure))
      .catch((error) => {
        console.error("[rest] Failed to build graph structure", error);
        res.status(500).json({ error: "Failed to build graph structure" });
      });
  });

  return router;
}
