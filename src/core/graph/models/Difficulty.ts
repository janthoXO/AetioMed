import z from "zod";

export const DifficultySchema = z.enum(["easy", "medium", "hard"]);

export type Difficulty = z.infer<typeof DifficultySchema>;
