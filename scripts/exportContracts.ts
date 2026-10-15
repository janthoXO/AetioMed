// Writes the API's JSON Schemas to contracts/, for clients to generate their types from.
// Zod stays the source of truth; rerun after changing a wire schema.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { ConfigSchema } from "@/core/graph/config.js";
import {
  CancelReplySchema,
  CaseGenerationResponseSchema,
  ErrorResponseSchema,
  HealthSchema,
  JobStatusReplySchema,
  makeCaseGenerationRequestSchema,
} from "@/api/index.js";
import { PlanPayloadSchema } from "@/core/caseGenerationService.js";
import {
  JobAcceptedEventSchema,
  JobCompleteEventSchema,
  LabelEventSchema,
} from "@/core/jobEvents/index.js";
import { GraphStructureSchema } from "@/core/graph/structure.js";
import {
  AllowedLlmsSchema,
  DiagnosesSchema,
  FeaturesSchema,
  ProcedureCatalogSchema,
} from "@/core/readModel.js";

// Only LANGUAGES shapes the contract (the `language` enum); the LLM fallback just lets this run without .env.
const config = ConfigSchema.parse({
  LLM_PROVIDER: "ollama",
  LLM_MODEL: "contract",
  ...process.env,
});

// name -> [schema, where it travels]
const contracts: Record<string, [z.ZodType, string]> = {
  CaseGenerationRequest: [
    makeCaseGenerationRequestSchema(config),
    "Body of POST /api/cases; NATS cases.request.generate (jobId required there).",
  ],
  CaseGenerationResponse: [
    CaseGenerationResponseSchema,
    "Case or error: POST /api/cases 200 / SSE `event: result`; NATS cases.result.<jobId>.",
  ],
  ErrorResponse: [
    ErrorResponseSchema,
    "Every REST error status; SSE `event: error`.",
  ],
  PlanPayload: [
    PlanPayloadSchema,
    "Plan-mode POST /api/cases 200; SSE `event: plan`; NATS cases.plan.<jobId>.",
  ],
  JobAcceptedEvent: [
    JobAcceptedEventSchema,
    "SSE `event: accepted` on POST /api/cases; NATS cases.progress.<jobId>.accepted.",
  ],
  LabelEvent: [
    LabelEventSchema,
    "SSE `event: label`; NATS cases.progress.<jobId>.label.",
  ],
  JobCompleteEvent: [
    JobCompleteEventSchema,
    "SSE `event: complete` on GET /api/cases/:jobId/labels; NATS cases.progress.<jobId>.complete.",
  ],
  JobStatusReply: [JobStatusReplySchema, "NATS cases.status.<jobId> reply."],
  CancelReply: [CancelReplySchema, "NATS cases.cancel.<jobId> reply."],
  Diagnoses: [DiagnosesSchema, "GET /api/diagnosis; NATS catalog.diagnosis."],
  ProcedureCatalog: [
    ProcedureCatalogSchema,
    "GET /api/procedures; NATS catalog.procedures.",
  ],
  Features: [FeaturesSchema, "GET /api/features; NATS meta.features."],
  AllowedLlms: [
    AllowedLlmsSchema,
    "GET /api/allowedLlms; NATS meta.allowedLlms.",
  ],
  GraphStructure: [GraphStructureSchema, "GET /api/graph; NATS meta.graph."],
  Health: [HealthSchema, "GET /api/health."],
};

// Wipe first: a removed contract must not linger.
rmSync("contracts", { recursive: true, force: true });
mkdirSync("contracts");
for (const [name, [schema, description]] of Object.entries(contracts)) {
  // Request: "input" — what a client sends, defaulted fields optional. Rest: what the server sends.
  const io = name === "CaseGenerationRequest" ? "input" : "output";
  writeFileSync(
    `contracts/${name}.schema.json`,
    JSON.stringify(
      { title: name, description, ...z.toJSONSchema(schema, { io }) },
      null,
      2
    ) + "\n"
  );
}
