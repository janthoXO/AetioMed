import z from "zod";
import {
  generateInconsistencies as generateInconsistenciesGateway,
  fixCaseInconsistencies as fixCaseInconsistenciesGateway,
} from "@/core/graph/03aigateway/consistency.aigateway.js";
import { CaseSchema, type Case } from "@/core/graph/models/Case.js";
import {
  InconsistencySchema,
  type Inconsistency,
} from "@/core/graph/models/Inconsistency.js";
import { DiagnosisSchema } from "@/core/graph/models/Diagnosis.js";
import { GenerationFlagSchema } from "@/core/graph/models/GenerationFlags.js";
import { AnamnesisCategorySchema } from "@/core/graph/models/Anamnesis.js";
import { ProcedureNameSchema } from "@/core/graph/models/Procedure.js";
import type { Tool } from "@/core/graph/utils/tool.js";

const GenerateInconsistenciesInputSchema = z.object({
  case: CaseSchema,
  diagnosis: DiagnosisSchema,
  generationFlags: z.array(GenerationFlagSchema),
  userInstructions: z.string().optional(),
});

const FixCaseInconsistenciesInputSchema = z.object({
  case: CaseSchema,
  inconsistencies: z.array(InconsistencySchema),
  generationFlags: z.array(GenerationFlagSchema),
  anamnesisCategories: z.array(AnamnesisCategorySchema).optional(),
  procedureNameList: z.array(ProcedureNameSchema).optional(),
  userInstructions: z.string().optional(),
});

export const generateInconsistencies: Tool<
  z.infer<typeof GenerateInconsistenciesInputSchema>,
  Inconsistency[]
> = {
  name: "generate_inconsistencies",
  description:
    "Detect clinical, logical, and pedagogical inconsistencies in a generated medical case.",
  inputSchema: GenerateInconsistenciesInputSchema,
  invoke: ({ case: c, diagnosis, userInstructions }, context) =>
    generateInconsistenciesGateway(c, diagnosis, userInstructions, context),
};

export const fixCaseInconsistencies: Tool<
  z.infer<typeof FixCaseInconsistenciesInputSchema>,
  Case
> = {
  name: "fix_case_inconsistencies",
  description:
    "Fix clinical and logical inconsistencies in a generated medical case.",
  inputSchema: FixCaseInconsistenciesInputSchema,
  invoke: (
    {
      case: c,
      inconsistencies,
      anamnesisCategories,
      procedureNameList,
      userInstructions,
    },
    context
  ) =>
    fixCaseInconsistenciesGateway(
      c,
      inconsistencies,
      anamnesisCategories,
      procedureNameList,
      userInstructions,
      context
    ),
};

export const inconsistencyTools = {
  generateInconsistencies,
  fixCaseInconsistencies,
} as const;
