// Bytes never reach a prompt: a prompt string built from content parts never
// embeds a byte payload.
//
// First test is a NEGATIVE CONTROL. `renderForPrompt` is YAML, so a leaked
// `Uint8Array` renders as a long list of integers, not "Uint8Array" or base64.
// `looksLikeByteDump` is checked against a real leak first, else the other
// assertions prove nothing.
import { describe, expect, it } from "vitest";
import {
  encodeText,
  textOf,
  type ContentPart,
} from "@/core/graph/models/ContentPart.js";
import { buildPrompt, renderForPrompt, section } from "./prompt.js";

/** Fixture builder for a text part. */
function fixtureTextPart(alt: string): ContentPart {
  return { type: "text/plain", value: encodeText(alt), alt };
}

/**
 * Leaked byte payload once rendered: base64 run or, more likely, YAML sequence
 * of bare integers. Exported so other suites reuse this detector.
 */
export function looksLikeByteDump(rendered: string): boolean {
  const base64Blob = /[A-Za-z0-9+/]{40,}={0,2}/;
  const yamlIntegerRun = /(?:^[ \t]*-[ \t]*\d{1,3}[ \t]*$\n?){8,}/m;
  return (
    base64Blob.test(rendered) ||
    yamlIntegerRun.test(rendered) ||
    rendered.includes("Uint8Array") ||
    rendered.includes("[object Object]")
  );
}

const mixedParts: ContentPart[] = [
  fixtureTextPart("Chest X-ray ordered."),
  {
    type: "image/png",
    alt: "PA chest radiograph, right lower lobe consolidation.",
    value: new Uint8Array(200).fill(137),
  },
  fixtureTextPart("Impression: right lower lobe pneumonia."),
];

describe("bytes never reach a prompt", () => {
  it("negative control: the detector fires on raw parts, so the tests below are not vacuous", () => {
    // Domain shape straight to renderer. If detector stops firing, every
    // other assertion here proves nothing.
    const leaked = renderForPrompt({ chiefComplaint: mixedParts });

    expect(looksLikeByteDump(leaked)).toBe(true);
  });

  it("textOf-derived prompt sections carry only alt text", () => {
    const rendered = buildPrompt(
      section(
        "Procedures ordered so far (with results)",
        `1. Chest X-ray -> ${textOf(mixedParts)}`
      )
    );

    expect(looksLikeByteDump(rendered)).toBe(false);
    expect(rendered).toContain("PA chest radiograph");
  });

  it("a text-projected Presentation renders through renderForPrompt with no bytes", () => {
    // Mirrors `Presentation` from `presentationOf` (03procedure/index.ts): all strings via `textOf`.
    const presentation = {
      patient: {
        name: "Jane",
        age: 40,
        height: 165,
        weight: 60,
        gender: "female" as const,
      },
      chiefComplaint: textOf([fixtureTextPart("Cough for three days.")]),
      anamnesis: [{ category: "History", answer: textOf(mixedParts) }],
    };

    const rendered = renderForPrompt(presentation);

    expect(looksLikeByteDump(rendered)).toBe(false);
    expect(rendered).toContain("PA chest radiograph");
  });
});
