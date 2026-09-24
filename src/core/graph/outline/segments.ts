import { z } from "zod";

/**
 * Positional segment model for the outline. LLM emits markdown with
 * server-owned headings in `<fixed>…</fixed>`; split into a **segment array**
 * strictly alternating editable/fixed. Compare **by position**, never label
 * text (position anchors a heading to the skeleton).
 *
 * Canonical shape: `length` odd; even indices editable (`fixed: false`, may
 * be empty string), odd indices fixed.
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

/** Splits tagged markdown into canonical segments. Editable gaps (incl. leading/trailing) always present, possibly empty, so index math needs no special case. */
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

/** Inverse of {@link parseTaggedOutline}, for feeding an outline back to the LLM. Exact round-trip for trimmed canonical segments. */
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

/** Prompt-ready text for downstream generators. Fixed text as-is; editable text has `<fixed>`/`</fixed>` escaped so an edit cannot recreate server-owned structure. */
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
 * Ordered fixed segment texts the LLM must reproduce. Configured catalogue:
 * one `### <category>` per category between `## Anamnesis` and `## Procedures`.
 * Freeform: LLM names them; see {@link checkSkeleton}.
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
 * Checks fixed sections match the expected skeleton; retry signal for a
 * malformed LLM outline. Input is `parseTaggedOutline` output (alternation
 * guaranteed).
 *
 * Freeform: categories are the `### <name>` headings between Anamnesis and
 * Procedures; a heading without that prefix is left out, surfacing as a
 * mismatch at its index.
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

/** Whether `segments` has canonical alternating shape; a handed-back plan must pass before skeleton check. */
export function isCanonicalShape(segments: OutlineSegments): boolean {
  return (
    segments.length % 2 === 1 &&
    segments.every((segment, i) => segment.fixed === (i % 2 === 1))
  );
}

/**
 * Restores server English headings by position in a plan translated in from
 * the request language (translation need not round-trip to what
 * {@link checkSkeleton} expects). Freeform LLM-named categories keep their
 * translation. Wrong fixed-segment count: returned as is, for `checkSkeleton` to reject.
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
