// Test support only — imported by `*.test.ts` files, never by production
// code.
import type {
  GenerateCaseFn,
  GraphAppContext,
} from "@/core/graph/appContext.js";
import { outlineSkeleton } from "@/core/graph/shared/outline/segments.js";

type GraphFake = Pick<
  GraphAppContext,
  "planCase" | "renderCase" | "translateOutline"
>;

/**
 * Adapt whole-pipeline fake (`generateCase`) to plan/case split: `planCase`
 * always accepts, `renderCase` calls `generateCase` with options `planCase`
 * received. Options travel inside the outline text (the editable segment after the
 * last heading, i.e. the `procedures` section), so concurrent jobs never mix. The outline is the real
 * (freeform, no categories) skeleton, so a handed-back plan passes
 * `checkSkeleton`.
 */
export function planAndRenderFrom(generateCase: GenerateCaseFn): GraphFake {
  const headings = outlineSkeleton({});
  return {
    async planCase(opts) {
      return {
        diagnosis: opts.diagnosis,
        outlineAccepted: true,
        outlineSegments: [
          ...headings.flatMap((text) => [
            { fixed: false, text: "" },
            { fixed: true, text },
          ]),
          { fixed: false, text: JSON.stringify(opts) },
        ],
      };
    },
    async renderCase({ outlineSections }) {
      return generateCase(JSON.parse(outlineSections.procedures));
    },
    translateOutline: undefined,
  };
}
