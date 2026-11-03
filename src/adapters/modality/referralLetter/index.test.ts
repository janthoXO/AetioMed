import { describe, expect, it } from "vitest";
import type { GraphRuntime, LlmPort } from "@/core/graph/runtime.js";
import { runWithContext } from "@/core/graph/utils/context.js";
import { referralLetterProvider } from "./index.js";

describe("referralLetterProvider", () => {
  it("drafts the letter from alt in the request language, then renders it as a PDF", async () => {
    const letter = {
      sender_name: "Anna Weber",
      recipient_specialty: "Kardiologie",
      reason: "Abklärung Thoraxschmerz",
      urgent: true,
      suspected_diagnosis: "V.a. ACS",
      history: null,
      findings: "EKG: ST-Hebung",
    };
    const systems: string[] = [];
    const llm: LlmPort = {
      async structured(_call, { system }) {
        systems.push(system);
        return { letters: [letter] } as never;
      },
      async text() {
        throw new Error("unexpected text call");
      },
    };
    // The drafter only touches `runtime.llm`.
    const runtime = { llm } as unknown as GraphRuntime;
    const rendered: [unknown, string][] = [];
    const provider = referralLetterProvider(
      runtime,
      async (l, language) => {
        rendered.push([l, language]);
        return new TextEncoder().encode("%PDF");
      },
      "desc"
    );

    const out = await runWithContext(
      () => provider.render([{ input: {}, alt: "GP refers, V.a. ACS" }], {}),
      "job",
      undefined,
      "de"
    );

    expect(provider.description).toBe("desc");
    expect(provider.mime).toBe("application/pdf");
    expect(new TextDecoder().decode(out[0])).toBe("%PDF");
    expect(rendered).toEqual([[letter, "de"]]);
    expect(systems[0]).toContain("German");
  });
});
