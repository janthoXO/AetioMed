import express from "express";
import type { ReadModel } from "@/core/readModel.js";

export default function createProceduresRouter(readModel: ReadModel) {
  const router = express.Router();

  router.get("/", async (_, res) => {
    res.status(200).json(readModel.procedures());
  });

  return router;
}
