import z from "zod";

/** Per-request run mode. `normal`: end to end, outline in English. `plan`: stops after outline for review/edit in request language. */
export const RunModeSchema = z.enum(["normal", "plan"]);

export type RunMode = z.infer<typeof RunModeSchema>;
