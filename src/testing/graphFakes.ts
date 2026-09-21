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
 * Adapt a whole-pipeline fake (`generateCase`) to the plan/case split
 * (#159): `planCase` always accepts, and `renderCase` calls `generateCase`
 * with the options `planCase` received. Those options travel inside the
 * outline text itself, so concurrent jobs never mix them up.
 */
export function planAndRenderFrom(generateCase: GenerateCaseFn): GraphFake {
  const MARKER = "## Plan options";
  return {
    async planCase(opts) {
      return {
        diagnosis: opts.diagnosis,
        userInstructions: opts.userInstructions,
        basisFragments: [],
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
