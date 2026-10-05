// Manual smoke test: the blinded System One pick against a local Ollama, same case in
// English and German. `ollama pull nimble`, then
// `SYSTEM_ONE_URL=http://localhost:11434 pnpm exec tsx scripts/systemOneSmoke.ts`.
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import z from "zod";
import { procedureTreeSchema } from "@/core/graph/shared/domain/ProcedureTree.js";
import { createSystemOnePort } from "@/adapters/ai/systemOne.js";
import { InMemoryProcedureCatalog } from "@/adapters/catalog/procedures/index.js";
import { InMemoryAnamnesisCatalog } from "@/adapters/catalog/anamnesis/index.js";
import { InMemoryLabelCatalog } from "@/adapters/catalog/labels/index.js";
import { InMemoryDiagnosisCatalog } from "@/adapters/catalog/diagnosis/index.js";
import { SystemOnePick } from "@/core/graph/04-case/02-procedures/solver/systemOnePick.js";
import type { ProcedureStrategy } from "@/core/graph/04-case/02-procedures/solver/ports.js";
import type { GraphRuntime } from "@/core/graph/runtime.js";

const url = process.env.SYSTEM_ONE_URL ?? "http://localhost:11434";
const model = process.env.SYSTEM_ONE_MODEL ?? "nimble";

const cases = {
  English: {
    chiefComplaint:
      "58-year-old man with acute-onset pleuritic chest pain and dyspnea for 6 hours, three days after knee replacement surgery.",
    anamnesis: [
      {
        category: "Vital signs",
        answer: "HR 118/min, BP 105/70 mmHg, SpO2 89 % on room air, RR 26/min.",
      },
      {
        category: "Physical examination",
        answer: "Swollen, tender left calf. Lungs clear on auscultation.",
      },
    ],
  },
  German: {
    chiefComplaint:
      "58-jähriger Mann mit akut einsetzenden atemabhängigen Thoraxschmerzen und Dyspnoe seit 6 Stunden, drei Tage nach Knieprothesen-Operation.",
    anamnesis: [
      {
        category: "Vitalzeichen",
        answer:
          "HF 118/min, RR 105/70 mmHg, SpO2 89 % unter Raumluft, AF 26/min.",
      },
      {
        category: "Körperliche Untersuchung",
        answer:
          "Geschwollene, druckschmerzhafte linke Wade. Lunge auskultatorisch frei.",
      },
    ],
  },
};

const runtime: GraphRuntime = {
  llm: {
    structured: async () => ({ action: "continue" }) as never,
    text: async () => "",
  },
  catalogs: {
    procedures: new InMemoryProcedureCatalog(
      procedureTreeSchema(z.object({ name: z.string() })).parse(
        parse(readFileSync("data/procedures.yml", "utf8"))
      )
    ),
    anamnesis: new InMemoryAnamnesisCatalog(),
    labels: new InMemoryLabelCatalog(),
    diagnosis: new InMemoryDiagnosisCatalog(),
  },
  log: { info: console.log, warn: console.warn, error: console.error },
  clock: () => new Date(),
};

const pick = new SystemOnePick(
  runtime,
  {
    port: createSystemOnePort({ url, model }),
    pickThreshold: Number(process.env.SYSTEM_ONE_PICK_THRESHOLD ?? 0.5),
    pickMax: Number(process.env.SYSTEM_ONE_PICK_MAX ?? 3),
  },
  {} as ProcedureStrategy
);

for (const [language, presentation] of Object.entries(cases)) {
  const start = Date.now();
  const move = await pick.nextStep({
    presentation,
    previousProcedures: [],
    ruledOutDiagnoses: [],
    iterationsRemaining: 6,
  });
  console.log(`${language} (${Date.now() - start} ms):`, JSON.stringify(move));
}
