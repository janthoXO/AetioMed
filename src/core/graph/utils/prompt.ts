import { stringify as stringifyYaml } from "yaml";
import z from "zod";

/**
 * Concatenates the provided prompt sections with blank lines between them and
 * removes any empty or undefined sections.
 */
export function buildPrompt(...parts: (string | undefined)[]): string {
  return parts.filter((s): s is string => !!s).join("\n\n");
}

/**
 * Renders a markdown-headed prompt section, or undefined when the body is
 * empty so it composes with `buildPrompt`'s filtering.
 */
export function section(
  header: string,
  body: string | undefined
): string | undefined {
  return body ? `## ${header}\n${body}` : undefined;
}

/**
 * Renders a data payload as human-readable YAML for inclusion in a prompt,
 * instead of brace-noisy `JSON.stringify` output.
 */
export function renderForPrompt(value: unknown): string {
  return stringifyYaml(value, { lineWidth: 0 }).trimEnd();
}

/**
 * Renders the (already filtered) user-instructions record as `key: value`
 * lines for inclusion in a prompt. Returns undefined when there is nothing
 * to render.
 */
export function renderUserInstructions(
  userInstructions: Partial<Record<string, string>> | undefined
): string | undefined {
  if (!userInstructions) return undefined;
  const entries = Object.entries(userInstructions).filter(([, v]) => !!v);
  if (entries.length === 0) return undefined;
  return entries.map(([key, value]) => `${key}: ${value}`).join("\n");
}

// ─── Schema rendering ─────────────────────────────────────────────────────────

/**
 * Literal unions longer than this are collapsed to `string` with a comment,
 * so per-request restricted vocabularies (procedure names, anamnesis
 * categories) don't get dumped into the schema block — the grammar constraint
 * from `withStructuredOutput` still enforces them.
 */
const MAX_LITERAL_UNION = 8;

type JsonSchema = {
  type?: string;
  enum?: unknown[];
  const?: unknown;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  additionalProperties?: JsonSchema | boolean;
  description?: string;
};

/**
 * Renders a Zod schema as a commented pseudo-schema for prompts, e.g.:
 *
 *   {
 *     "name": string, // Name of the medical procedure
 *     "relevance": "obligatory" | "optional" | "contraindicated"
 *   }
 *
 * Field descriptions come from `.describe()` on the Zod schema, so the prompt
 * text and the grammar constraint passed to `withStructuredOutput` stay in
 * sync by construction.
 */
export function renderSchemaForPrompt(schema: z.ZodType): string {
  const jsonSchema = z.toJSONSchema(schema, {
    io: "output",
    unrepresentable: "any",
  }) as JsonSchema;
  return renderNode(jsonSchema, "");
}

function renderNode(node: JsonSchema, indent: string): string {
  if (node.const !== undefined) return JSON.stringify(node.const);

  if (node.enum) {
    if (node.enum.length > MAX_LITERAL_UNION) return "string";
    return node.enum.map((v) => JSON.stringify(v)).join(" | ");
  }

  const variants = node.anyOf ?? node.oneOf;
  if (variants) {
    const parts = variants.map((variant) => renderNode(variant, indent));
    if (parts.some((p) => p.includes("\n"))) {
      return parts.join(`\n${indent}// OR\n${indent}`);
    }
    return parts.join(" | ");
  }

  switch (node.type) {
    case "object": {
      const inner = `${indent}  `;
      const properties = Object.entries(node.properties ?? {});
      if (properties.length === 0) {
        // e.g. records: render the value shape against a placeholder key
        if (typeof node.additionalProperties === "object") {
          const value = renderNode(node.additionalProperties, inner);
          return `{\n${inner}"<key>": ${value},\n${inner}...\n${indent}}`;
        }
        return "{ ... }";
      }
      const required = node.required ?? [];
      const lines = properties.map(([key, propNode], i) => {
        const value = renderNode(propNode, inner);
        const comma = i < properties.length - 1 ? "," : "";
        const comment = renderComment(propNode, required.includes(key));
        return `${inner}"${key}": ${value}${comma}${comment}`;
      });
      return `{\n${lines.join("\n")}\n${indent}}`;
    }
    case "array": {
      const item = renderNode(node.items ?? {}, `${indent}  `);
      if (item.includes("\n")) {
        return `[\n${indent}  ${item},\n${indent}  ...\n${indent}]`;
      }
      return `[ ${item}, ... ]`;
    }
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    default:
      return "any";
  }
}

function renderComment(node: JsonSchema, isRequired: boolean): string {
  const notes: string[] = [];
  if (node.enum && node.enum.length > MAX_LITERAL_UNION) {
    notes.push("must be an exact value from the provided list");
  }
  if (node.description) notes.push(node.description);
  if (!isRequired) notes.push("optional");
  return notes.length > 0 ? ` // ${notes.join("; ")}` : "";
}

// ─── Validation-error summarizing ─────────────────────────────────────────────

const MAX_ERROR_ISSUES = 5;
const MAX_ERROR_LENGTH = 500;

type ZodIssueLike = { path?: (string | number)[]; message: string };

/**
 * Condenses an LLM structured-output failure into a few short, actionable
 * lines for the retry prompt, instead of feeding the model a wall of
 * JSON-path noise from a raw Zod issues dump.
 */
export function summarizeValidationError(
  error: Error,
  maxLength: number = MAX_ERROR_LENGTH
): string {
  const issues = extractZodIssues(error);
  if (!issues || issues.length === 0) {
    return truncate(error.message, maxLength);
  }

  const lines = issues.slice(0, MAX_ERROR_ISSUES).map((issue) => {
    const path = renderIssuePath(issue.path);
    return path ? `field \`${path}\`: ${issue.message}` : issue.message;
  });
  if (issues.length > MAX_ERROR_ISSUES) {
    lines.push(`… (${issues.length - MAX_ERROR_ISSUES} more issues)`);
  }
  return truncate(lines.join("; "), maxLength);
}

function extractZodIssues(error: Error): ZodIssueLike[] | undefined {
  // A ZodError (or an error wrapping one) carries the issues directly.
  const direct = (error as { issues?: unknown }).issues;
  if (isIssueArray(direct)) return direct;

  // Otherwise the message may embed the JSON-stringified issues array
  // (e.g. LangChain's OutputParserException wrapping a ZodError message).
  const start = error.message.indexOf("[");
  const end = error.message.lastIndexOf("]");
  if (start === -1 || end <= start) return undefined;
  try {
    const parsed: unknown = JSON.parse(error.message.slice(start, end + 1));
    if (isIssueArray(parsed)) return parsed;
  } catch {
    // message is not a JSON issues dump — fall through to plain truncation
  }
  return undefined;
}

function isIssueArray(value: unknown): value is ZodIssueLike[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (item) =>
        !!item &&
        typeof item === "object" &&
        typeof (item as ZodIssueLike).message === "string"
    )
  );
}

function renderIssuePath(path: (string | number)[] | undefined): string {
  if (!path || path.length === 0) return "";
  return path.reduce<string>(
    (acc, seg) =>
      typeof seg === "number"
        ? `${acc}[${seg}]`
        : acc
          ? `${acc}.${seg}`
          : String(seg),
    ""
  );
}

function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}…`;
}
