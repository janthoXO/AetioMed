import z from "zod";

export const PatientSchema = z.object({
  name: z.string(),
  age: z.number().int().nonnegative(),
  height: z.number().nonnegative(),
  weight: z.number().nonnegative(),
  gender: z.enum(["male", "female"]),
});

export type Patient = z.infer<typeof PatientSchema>;
