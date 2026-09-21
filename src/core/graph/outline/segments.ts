import { z } from "zod";

/**
 * Positional segment model for the plan-mode outline editor (#159).
 *
 * The LLM emits a case outline as markdown with its fixed (server-owned)
 * headings wrapped in `<fixed>…</fixed>` tags. We never store or diff that
 * markdown directly — we split it into a **segment array** that strictly
 * alternates editable and fixed text, and every downstream comparison
 * (what did the reviewer change? did they touch a heading?) is done **by
 * position**, never by matching label text. Matching by label would let a
 * reviewer who retypes a heading verbatim smuggle it through as "unchanged"
 * even though its *position* in the sequence — the only thing that actually
 * anchors it to the server's skeleton — may have moved.
 *
 * Canonical shape: `segments.length` is always odd. Even indices (0, 2, 4,
 * …) are editable (`fixed: false`); odd indices are fixed (`fixed: true`).
 * An editable segment may be the empty string — e.g. between two adjacent
 * fixed headings, or before the very first heading.
 */
export type OutlineSegment = { fixed: boolean; text: string };
export type OutlineSegments = OutlineSegment[];

export const FIXED_OPEN = "<fixed>";
export const FIXED_CLOSE = "</fixed>";

/** Thrown by {@link parseTaggedOutline} when the LLM's markdown is malformed. */
export class OutlineFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutlineFormatError";
  }
}

/** Transport schema for {@link OutlineSegments} — not the canonical-shape invariant itself. */
export const OutlineSegmentsSchema = z
  .array(
    z.object({
      fixed: z.boolean(),
      text: z.string().max(20_000),
    })
  )
  .max(200);

const TAG_RE = /<fixed>|<\/fixed>/g;

/**
 * Splits tag-delimited outline markdown into the canonical alternating
 * segment shape. Editable text between fixed blocks (and leading/trailing)
 * is always present, even as an empty string, so index arithmetic downstream
 * never has to special-case a missing gap.
 */
export function parseTaggedOutline(markdown: string): OutlineSegments {
  const segments: OutlineSegments = [];
  let cursor = 0;
  let insideFixed = false;

  TAG_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TAG_RE.exec(markdown))) {
    const tag = match[0];
    const textBefore = markdown.slice(cursor, match.index);
    cursor = match.index + tag.length;

    if (tag === FIXED_OPEN) {
      if (insideFixed) {
        throw new OutlineFormatError(
          `Nested <fixed> tag at position ${match.index}: a <fixed> block cannot open inside another <fixed> block`
        );
      }
      segments.push({ fixed: false, text: textBefore.trim() });
      insideFixed = true;
    } else {
      if (!insideFixed) {
        throw new OutlineFormatError(
          `Stray </fixed> tag at position ${match.index}: no matching <fixed> is open`
        );
      }
      const fixedText = textBefore.trim();
      if (!fixedText) {
        throw new OutlineFormatError(
          `Empty <fixed></fixed> block closing at position ${match.index}`
        );
      }
      segments.push({ fixed: true, text: fixedText });
      insideFixed = false;
    }
  }

  if (insideFixed) {
    throw new OutlineFormatError(
      "Unclosed <fixed> tag: reached end of outline without a matching </fixed>"
    );
  }

  segments.push({ fixed: false, text: markdown.slice(cursor).trim() });
  return segments;
}

/**
 * Inverse of {@link parseTaggedOutline}, for feeding a previous outline back
 * to the LLM (e.g. on a revise loop). Round-trips exactly for canonical
 * segments whose texts are already trimmed.
 */
export function renderTaggedOutline(segments: OutlineSegments): string {
  const parts: string[] = [];
  for (const segment of segments) {
    if (segment.fixed) {
      parts.push(`${FIXED_OPEN}${segment.text}${FIXED_CLOSE}`);
    } else if (segment.text !== "") {
      parts.push(segment.text);
    }
  }
  return parts.join("\n\n");
}

/**
 * Prompt-ready text for downstream generators that consume the outline as
 * plain prose (patient/chief-complaint/anamnesis generation, etc). Fixed
 * text is emitted as-is; editable text has any `<fixed>`/`</fixed>` a
 * reviewer might have typed escaped first, so a submitted edit can never
 * re-create outline structure that only the server is allowed to own.
 */
export function joinOutline(segments: OutlineSegments): string {
  const parts: string[] = [];
  for (const segment of segments) {
    if (segment.fixed) {
      parts.push(segment.text);
    } else if (segment.text !== "") {
      parts.push(escapeFixedTags(segment.text));
    }
  }
  return parts.join("\n\n");
}

function escapeFixedTags(text: string): string {
  return text
    .replace(/<fixed>/g, "&lt;fixed&gt;")
    .replace(/<\/fixed>/g, "&lt;/fixed&gt;");
}

/** The five fixed top-level section headings every outline skeleton starts and ends with. */
export const OUTLINE_SECTIONS = Object.freeze([
  "## General",
  "## Patient",
  "## Chief complaint",
  "## Anamnesis",
  "## Procedures",
] as const);

/**
 * The ordered list of fixed segment texts the LLM must reproduce. With a
 * configured anamnesis catalogue, a `### <category>` heading is required per
 * category, between `## Anamnesis` and `## Procedures`; with no catalogue
 * (freeform anamnesis), the LLM names its own categories instead — see
 * {@link checkSkeleton}.
 */
export function outlineSkeleton(opts: {
  anamnesisCategories?: string[] | undefined;
}): string[] {
  const [general, patient, chiefComplaint, anamnesis, procedures] =
    OUTLINE_SECTIONS;
  const skeleton: string[] = [general, patient, chiefComplaint, anamnesis];
  if (opts.anamnesisCategories?.length) {
    for (const category of opts.anamnesisCategories) {
      skeleton.push(`### ${category}`);
    }
  }
  skeleton.push(procedures);
  return skeleton;
}

function validateCanonicalShape(
  segments: OutlineSegments
): { ok: true } | { ok: false; message: string } {
  if (segments.length % 2 === 0) {
    return {
      ok: false,
      message: `Expected an odd number of segments (alternating editable/fixed, starting and ending editable), got ${segments.length}`,
    };
  }
  for (let i = 0; i < segments.length; i++) {
    const expectedFixed = i % 2 === 1;
    const segment = segments[i]!;
    if (segment.fixed !== expectedFixed) {
      return {
        ok: false,
        message: `Segment at index ${i} should be ${expectedFixed ? "fixed" : "editable"} (odd indices are fixed, even indices are editable), but got ${segment.fixed ? "fixed" : "editable"}`,
      };
    }
  }
  return { ok: true };
}

/**
 * Validates the canonical shape and that the outline's fixed sections match
 * what the server expects to see — the retry signal for an LLM that emitted
 * a malformed or incomplete skeleton (#159).
 */
export function checkSkeleton(
  segments: OutlineSegments,
  opts: { anamnesisCategories?: string[] | undefined }
): { ok: true } | { ok: false; message: string } {
  const shapeCheck = validateCanonicalShape(segments);
  if (!shapeCheck.ok) return shapeCheck;

  const fixedTexts = segments.filter((s) => s.fixed).map((s) => s.text);

  if (opts.anamnesisCategories !== undefined) {
    const expected = outlineSkeleton(opts);
    for (let i = 0; i < Math.max(expected.length, fixedTexts.length); i++) {
      if (expected[i] !== fixedTexts[i]) {
        return {
          ok: false,
          message: `Fixed section mismatch at index ${i}: expected ${JSON.stringify(expected[i] ?? "<none>")}, got ${JSON.stringify(fixedTexts[i] ?? "<none>")}`,
        };
      }
    }
    return { ok: true };
  }

  // Freeform anamnesis catalogue: the five top-level headings in order, with
  // zero or more LLM-named `### <category>` headings between Anamnesis and
  // Procedures — never anywhere else.
  const [general, patient, chiefComplaint, anamnesis, procedures] =
    OUTLINE_SECTIONS;
  const fixedRequiredPrefix = [general, patient, chiefComplaint, anamnesis];
  for (let i = 0; i < fixedRequiredPrefix.length; i++) {
    if (fixedTexts[i] !== fixedRequiredPrefix[i]) {
      return {
        ok: false,
        message: `Fixed section mismatch at index ${i}: expected ${JSON.stringify(fixedRequiredPrefix[i])}, got ${JSON.stringify(fixedTexts[i] ?? "<none>")}`,
      };
    }
  }
  if (fixedTexts.length < fixedRequiredPrefix.length + 1) {
    return {
      ok: false,
      message: `Missing trailing ${JSON.stringify(procedures)} section`,
    };
  }
  const lastIndex = fixedTexts.length - 1;
  if (fixedTexts[lastIndex] !== procedures) {
    return {
      ok: false,
      message: `Fixed section mismatch at index ${lastIndex}: expected ${JSON.stringify(procedures)}, got ${JSON.stringify(fixedTexts[lastIndex])}`,
    };
  }
  for (let i = fixedRequiredPrefix.length; i < lastIndex; i++) {
    const text = fixedTexts[i]!;
    const name = text.startsWith("### ") ? text.slice(4).trim() : "";
    if (!text.startsWith("### ") || !name) {
      return {
        ok: false,
        message: `Fixed section mismatch at index ${i}: expected a "### <category>" anamnesis category heading with a non-empty name, got ${JSON.stringify(text)}`,
      };
    }
  }
  return { ok: true };
}

/**
 * Unicode-normalizes and canonicalizes whitespace so a reviewer's editor
 * (CRLF line endings, trailing spaces, decomposed accents) never registers
 * as a semantic edit.
 */
export function normalizeSegmentText(text: string): string {
  const nfc = text.normalize("NFC");
  const lf = nfc.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const trimmedLines = lf
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n");
  return trimmedLines.trim();
}

export type CompareSubmissionResult =
  | { ok: true; changed: number[] }
  | {
      ok: false;
      code: "SEGMENT_COUNT_MISMATCH" | "FIXED_SEGMENT_CHANGED";
      index?: number;
      message: string;
    };

/**
 * Diffs a submitted outline against the copy it was displayed with, purely
 * by position. Never trusts submitted `fixed` flags or text at a fixed
 * index — a reviewer's submission is not allowed to alter server-owned
 * structure, only the editable gaps between it.
 */
export function compareSubmission(
  display: OutlineSegments,
  submitted: OutlineSegments
): CompareSubmissionResult {
  if (display.length !== submitted.length) {
    return {
      ok: false,
      code: "SEGMENT_COUNT_MISMATCH",
      message: `Expected ${display.length} segments, got ${submitted.length}`,
    };
  }

  const changed: number[] = [];
  for (let i = 0; i < display.length; i++) {
    const displaySegment = display[i]!;
    const submittedSegment = submitted[i]!;

    if (displaySegment.fixed !== submittedSegment.fixed) {
      return {
        ok: false,
        code: "FIXED_SEGMENT_CHANGED",
        index: i,
        message: `Segment ${i} changed structure from ${displaySegment.fixed ? "fixed" : "editable"} to ${submittedSegment.fixed ? "fixed" : "editable"}`,
      };
    }

    const displayText = normalizeSegmentText(displaySegment.text);
    const submittedText = normalizeSegmentText(submittedSegment.text);
    if (displayText === submittedText) continue;

    if (displaySegment.fixed) {
      return {
        ok: false,
        code: "FIXED_SEGMENT_CHANGED",
        index: i,
        message: `Fixed segment ${i} (${JSON.stringify(displaySegment.text)}) was changed and cannot be edited`,
      };
    }
    changed.push(i);
  }

  return { ok: true, changed };
}

/** Structural + normalized-text equality, index by index. */
export function segmentsEqual(a: OutlineSegments, b: OutlineSegments): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const segA = a[i]!;
    const segB = b[i]!;
    if (segA.fixed !== segB.fixed) return false;
    if (normalizeSegmentText(segA.text) !== normalizeSegmentText(segB.text)) {
      return false;
    }
  }
  return true;
}

/**
 * Rebuilds a canonical outline from `original`, applying only the editable
 * replacements the caller supplies (e.g. per-segment translations, or the
 * submitted text itself where no translation is needed). Fixed segments
 * always come from `original` — `submitted` is used only to assert the two
 * arrays are the same shape, never read for content, so a caller cannot
 * accidentally let a submitted fixed-segment edit leak through here after
 * skipping {@link compareSubmission}.
 */
export function mergeSegments(
  original: OutlineSegments,
  submitted: OutlineSegments,
  replacements: ReadonlyMap<number, string>
): OutlineSegments {
  if (original.length !== submitted.length) {
    throw new Error(
      `mergeSegments: length mismatch (original has ${original.length} segments, submitted has ${submitted.length})`
    );
  }
  return original.map((segment, i) => {
    if (segment.fixed) return segment;
    const replacement = replacements.get(i);
    return replacement !== undefined
      ? { fixed: false, text: replacement }
      : segment;
  });
}
