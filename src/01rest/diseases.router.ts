import type { Diagnosis } from "@/02domain-models/Diagnosis.js";
import { diseases as diseaseEntries } from "@/02services/diseases.service.js";
import express from "express";

const router = express.Router();

router.use((_req, _res, next) => {
  /* #swagger.tags = ['Diseases'] */
  next();
});

router.get("/", async (_, res) => {
  const diseases = diseaseEntries.map(
    (d) =>
      ({
        name: d.names[0],
        icd: d.code,
      }) as Diagnosis
  );
  res.status(200).json(diseases);
});

export default router;
