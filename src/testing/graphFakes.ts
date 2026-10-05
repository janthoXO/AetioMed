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
 * received. Options travel inside outline text (the editable segment after the
 * last heading), so concurrent jobs never mix. The outline is the real
 * (freeform, no categories) skeleton, so a handed-back plan passes
 * `checkSkeleton`.
 */
export function planAndRenderFrom(generateCase: GenerateCaseFn): GraphFake {
  const headings = outlineSkeleton({});
  const last = headings.at(-1)!;
  return {
    async planCase(opts) {
      return {
        diagnosis: opts.diagnosis,
        userInstructions: opts.userInstructions,
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
    async renderCase({ outline }) {
      const json = outline.slice(outline.lastIndexOf(last) + last.length);
      return generateCase(JSON.parse(json));
    },
    translateOutline: undefined,
  };
}
