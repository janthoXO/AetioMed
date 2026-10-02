// Test support only — imported by `*.test.ts` files, never by production
// code.
import type {
  GenerateCaseFn,
  GraphAppContext,
} from "@/core/graph/appContext.js";

type GraphFake = Pick<
  GraphAppContext,
  "planCase" | "renderCase" | "translateOutline"
>;

/**
 * Adapt whole-pipeline fake (`generateCase`) to plan/case split: `planCase`
 * always accepts, `renderCase` calls `generateCase` with options `planCase`
 * received. Options travel inside outline text, so concurrent jobs never mix.
 */
export function planAndRenderFrom(generateCase: GenerateCaseFn): GraphFake {
  const MARKER = "## Plan options";
  return {
    async planCase(opts) {
      return {
        diagnosis: opts.diagnosis,
        userInstructions: opts.userInstructions,
        outlineAccepted: true,
        outlineSegments: [
          { fixed: false, text: "" },
          { fixed: true, text: MARKER },
          { fixed: false, text: JSON.stringify(opts) },
        ],
      };
    },
    async renderCase({ outline }) {
      const json = outline.slice(outline.indexOf(MARKER) + MARKER.length);
      return generateCase(JSON.parse(json));
    },
    translateOutline: undefined,
  };
}
