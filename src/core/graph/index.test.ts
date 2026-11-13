import { describe, expect, it, vi } from "vitest";
import z from "zod";
import { checkProviderAllowlists } from "./index.js";
import type { ModalityProvider } from "./shared/modality/ports.js";

const provider = (id: string): ModalityProvider<unknown> => ({
  id,
  mime: "text/plain",
  description: id,
  inputSchema: z.object({}),
  render: async () => [],
});

describe("checkProviderAllowlists", () => {
  it("logs per-provider coverage and skips freeform", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    checkProviderAllowlists("procedureResult", [provider("text")], undefined);
    expect(log).not.toHaveBeenCalled();
    checkProviderAllowlists(
      "procedureResult",
      [provider("text"), provider("ecg")],
      [{ name: "ECG", providers: ["ecg"] }, { name: "CBC" }]
    );
    expect(log).toHaveBeenCalledWith(
      "[modality] procedureResult: text 2/2, ecg 1/2"
    );
    log.mockRestore();
  });

  it("throws when a unit is left with no enabled provider", () => {
    expect(() =>
      checkProviderAllowlists(
        "anamnesis",
        [provider("text")],
        [
          { name: "Meds", providers: ["pedigree"] },
          { name: "HPI", providers: ["text"] },
        ]
      )
    ).toThrow(/"Meds"/);
  });
});
