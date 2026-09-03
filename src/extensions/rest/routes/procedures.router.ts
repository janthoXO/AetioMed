import express from "express";
import { procedureCatalog } from "@/core/graph/catalog/index.js";

const router = express.Router();

router.use((_req, _res, next) => {
  /* #swagger.tags = ['Procedures'] */
  next();
});

router.get("/", async (_, res) => {
  res.status(200).json(procedureCatalog.list()?.map((p) => ({ name: p })));
});

export default router;
