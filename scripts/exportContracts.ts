// Writes the API's JSON Schemas to contracts/, for clients to generate their types from.
// Zod stays the source of truth; rerun after changing a schema in src/api/.
import { mkdirSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { ConfigSchema } from "@/core/graph/config.js";
import {
  CaseGenerationResponseSchema,
  makeCaseGenerationRequestSchema,
} from "@/api/index.js";

// Only LANGUAGES shapes the contract (the `language` enum); the LLM fallback just lets this run without .env.
const config = ConfigSchema.parse({
  LLM_PROVIDER: "ollama",
  LLM_MODEL: "contract",
  ...process.env,
});

const contracts = {
  // "input": what a client sends — defaulted fields are optional.
  CaseGenerationRequest: z.toJSONSchema(
    makeCaseGenerationRequestSchema(config),
    { io: "input" }
  ),
  CaseGenerationResponse: z.toJSONSchema(CaseGenerationResponseSchema),
};

mkdirSync("contracts", { recursive: true });
for (const [name, schema] of Object.entries(contracts)) {
  writeFileSync(
    `contracts/${name}.schema.json`,
    JSON.stringify({ title: name, ...schema }, null, 2) + "\n"
  );
}
