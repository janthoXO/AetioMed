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
  return text.replace(/<(\/?)fixed>/g, "&lt;$1fixed&gt;");
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
  return [
    ...OUTLINE_SECTIONS.slice(0, 4),
    ...(opts.anamnesisCategories ?? []).map((category) => `### ${category}`),
    OUTLINE_SECTIONS[4],
  ];
}

/**
 * Validates that the outline's fixed sections match what the server expects
 * to see — the retry signal for an LLM that emitted a malformed or incomplete
 * skeleton (#159). Takes `parseTaggedOutline`'s output, whose alternating
 * shape is guaranteed by construction.
 *
 * Without a catalogue (freeform anamnesis) the categories are whatever
 * `### <name>` headings the LLM wrote between Anamnesis and Procedures; a
 * heading there without that prefix is left out of the expected skeleton,
 * so it surfaces as a mismatch at its own index.
 */
export function checkSkeleton(
  segments: OutlineSegments,
  opts: { anamnesisCategories?: string[] | undefined }
): { ok: true } | { ok: false; message: string } {
  const fixedTexts = segments.filter((s) => s.fixed).map((s) => s.text);
  const anamnesisCategories =
    opts.anamnesisCategories ??
    fixedTexts
      .slice(4, -1)
      .filter((text) => /^### \S/.test(text))
      .map((text) => text.slice(4));
  const expected = outlineSkeleton({ anamnesisCategories });

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

/**
 * Whether `segments` has the canonical alternating shape — the one thing a
 * handed-back plan must prove before its skeleton is even checked (#159).
 */
export function isCanonicalShape(segments: OutlineSegments): boolean {
  return (
    segments.length % 2 === 1 &&
    segments.every((segment, i) => segment.fixed === (i % 2 === 1))
  );
}

/**
 * Puts the server's own English headings back into a plan translated in
 * from the request language, by position (#159). A translated heading need
 * not round-trip to the exact English string {@link checkSkeleton} expects,
 * but every heading's English is known — except, with a freeform catalogue,
 * the LLM-named anamnesis categories, which keep their translation. A plan
 * with the wrong number of fixed segments is returned as is, for
 * `checkSkeleton` to reject.
 */
export function restoreSkeletonHeadings(
  segments: OutlineSegments,
  opts: { anamnesisCategories?: string[] | undefined }
): OutlineSegments {
  const fixedCount = segments.filter((s) => s.fixed).length;
  const categories = opts.anamnesisCategories;
  if (
    categories
      ? fixedCount !== OUTLINE_SECTIONS.length + categories.length
      : fixedCount < OUTLINE_SECTIONS.length
  ) {
    return segments;
  }

  let k = 0;
  return segments.map((segment) => {
    if (!segment.fixed) return segment;
    const i = k++;
    const text =
      i < 4
        ? OUTLINE_SECTIONS[i]!
        : i === fixedCount - 1
          ? OUTLINE_SECTIONS[4]
          : categories
            ? `### ${categories[i - 4]}`
            : segment.text;
    return { fixed: true, text };
  });
}

/**
 * Unicode-normalizes and canonicalizes whitespace so a reviewer's editor
 * (CRLF line endings, trailing spaces, decomposed accents) never registers
 * as a semantic edit.
 */
export function normalizeSegmentText(text: string): string {
  return text
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .trim();
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

/**
 * Rebuilds a canonical outline from `original`, applying only the editable
 * replacements the caller supplies (per-segment translations, or the
 * submitted text itself where no translation is needed). Fixed segments
 * always come from `original`, so a submitted heading can never leak
 * through here.
 */
export function mergeSegments(
  original: OutlineSegments,
  replacements: ReadonlyMap<number, string>
): OutlineSegments {
  return original.map((segment, i) => {
    if (segment.fixed) return segment;
    const replacement = replacements.get(i);
    return replacement !== undefined
      ? { fixed: false, text: replacement }
      : segment;
  });
}
