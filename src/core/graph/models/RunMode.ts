import z from "zod";

/**
 * Per-request run mode (#159). `normal` runs the pipeline end to end with
 * the outline in English; `plan` pauses after the outline stage so the
 * requester can review and edit it in the request language.
 */
export const RunModeSchema = z.enum(["normal", "plan"]);

export type RunMode = z.infer<typeof RunModeSchema>;
