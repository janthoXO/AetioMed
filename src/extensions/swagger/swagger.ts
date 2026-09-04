import "dotenv/config";
import { makeCaseGenerationRequestSchema } from "@/extensions/api/CaseGenerationRequest.js";
import swaggerAutogen from "swagger-autogen";
import { createSchema } from "zod-openapi";
import * as fs from "node:fs/promises";
import { CaseGenerationResponseSchema } from "@/extensions/api/CaseGenerationResponse.js";
import { ConfigSchema } from "@/core/graph/config.js";

// Standalone doc-generation script (`pnpm swagger`) — not part of the
// running server, so it resolves its own graph config from `process.env`
// rather than receiving one from `createApp()`.
const graphConfig = ConfigSchema.parse(process.env);
const CaseGenerationRequestSchema =
  makeCaseGenerationRequestSchema(graphConfig);

const { schemas } = Object.entries({
  CaseGenerationRequest: CaseGenerationRequestSchema,
  CaseGenerationResponse: CaseGenerationResponseSchema,
}).reduce(
  (acc, [key, zodObject]) => {
    const { schema } = createSchema(zodObject);
    return {
      schemas: { ...acc.schemas, [key]: schema },
    };
  },
  { schemas: {} }
);

const doc = {
  info: {
    title: "AetioMed API",
    description: "API Documentation",
  },
  host: "localhost:3030",
  tags: [
    {
      name: "Cases",
      description: "Cases endpoints",
    },
  ],
};

const outputFile = "./swagger-output.json";
const routes = ["./router.ts"];

await swaggerAutogen({ openapi: "3.0.0" })(outputFile, routes, doc);

const outputFilePath = import.meta.dirname + outputFile.slice(1);
// parse the json file
await fs
  .readFile(outputFilePath, "utf8")
  .then((data) => JSON.parse(data))
  .then((docJson) => {
    // add the schema to the doc
    docJson.components = {
      schemas,
    };

    return docJson;
  })
  // write the doc to the json file
  .then((docJson) =>
    fs.writeFile(outputFilePath, JSON.stringify(docJson, null, 2))
  );
