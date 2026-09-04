// Issue 11 §4/§8: bytes must never reach a prompt. Prompt builders take
// `string`, never `ContentPart[]` — enforced in the type system (a prompt
// builder handed `ContentPart[]` does not type-check) — and this test
// asserts the runtime property that actually matters: a prompt string built
// from content parts never embeds a byte payload.
//
// The first test is a NEGATIVE CONTROL and is the reason the rest mean
// anything. `renderForPrompt` is YAML, so a leaked `Uint8Array` does not
// appear as "Uint8Array", "[object Object]" or base64 — it appears as a long
// list of integers. A detector that only looked for those three strings would
// pass on the unprojected shape too, making every other assertion here
// decorative. `looksLikeByteDump` is checked against a real leak first.
import { describe, expect, it } from "vitest";
import {
  textOf,
  textPart,
  type ContentPart,
} from "@/core/graph/models/ContentPart.js";
import { buildPrompt, renderForPrompt, section } from "./prompt.js";

/**
 * What a leaked byte payload actually looks like once rendered: either a run
 * of base64 (if something encoded it) or, far more likely here, a YAML
 * sequence of bare integers.
 */
// Exported so other suites that must prove "no bytes reach a prompt" (e.g.
// issue 12's translation-prompt tests) reuse this exact detector rather than
// writing a second, weaker one — see the file-level comment on the negative
// control above.
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
  textPart("Chest X-ray ordered."),
  {
    type: "image/png",
    alt: "PA chest radiograph, right lower lobe consolidation.",
    value: new Uint8Array(200).fill(137),
  },
  textPart("Impression: right lower lobe pneumonia."),
];

describe("bytes never reach a prompt (issue 11 §4)", () => {
  it("negative control: the detector fires on raw parts, so the tests below are not vacuous", () => {
    // Exactly what the old code path did — hand the domain shape straight to
    // the renderer. If this ever stops tripping the detector, every other
    // assertion in this file has silently stopped proving anything.
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
    // Mirrors the `Presentation` shape `presentationOf` builds
    // (03procedure/index.ts) — every field already a string, via `textOf`.
    const presentation = {
      patient: {
        name: "Jane",
        age: 40,
        height: 165,
        weight: 60,
        gender: "female" as const,
      },
      chiefComplaint: textOf([textPart("Cough for three days.")]),
      anamnesis: [{ category: "History", answer: textOf(mixedParts) }],
    };

    const rendered = renderForPrompt(presentation);

    expect(looksLikeByteDump(rendered)).toBe(false);
    expect(rendered).toContain("PA chest radiograph");
  });
});
