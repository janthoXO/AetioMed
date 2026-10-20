import { describe, expect, it } from "vitest";
import { ICDCodeSchema } from "./Diagnosis.js";

describe("ICDCodeSchema", () => {
  it.each(["1A00", "BA41", "CA40", "5A14", "DB10.02", "DB98.7Z", "CA40.Z"])(
    "accepts stem code %s",
    (code) => expect(ICDCodeSchema.safeParse(code).success).toBe(true)
  );

  it.each(["CA40.Z&XB22", "CA40.Z&XB22&XK9K", "1B7Y/MG51.00", "2A00&XN3SX"])(
    "accepts cluster %s",
    (code) => expect(ICDCodeSchema.safeParse(code).success).toBe(true)
  );

  it.each([
    "../../admin?x=1A",
    "hello WORLD",
    "ba00",
    "",
    "01",
    "A02.0",
    "1A00&XN",
    "1A00&BA41",
    "CA40.Z&",
    "CA40.Z&&XB22",
    "CA40.Z/../admin",
    "&XB22",
    "CA40.123",
  ])("rejects %j", (code) =>
    expect(ICDCodeSchema.safeParse(code).success).toBe(false)
  );
});
