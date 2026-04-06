import z from "zod";
import { GenerationFlagSchema } from "./GenerationFlags.js";

export const UserInstructionsKeySchema = GenerationFlagSchema.or(
  z.literal("general")
);

export type UserInstructionsKey = z.infer<typeof UserInstructionsKeySchema>;

export const UserInstructionsSchema = z
  .partialRecord(UserInstructionsKeySchema, z.string())
  .describe("Additional context for case generation");

export type UserInstructions = z.infer<typeof UserInstructionsSchema>;
