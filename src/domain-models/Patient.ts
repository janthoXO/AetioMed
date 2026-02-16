import z from "zod";

export const PatientSchema = z.object({
  name: z.string(),
  age: z.number().int().nonnegative(),
  height: z.number().nonnegative(),
  weight: z.number().nonnegative(),
  gender: z.enum(["male", "female"]),
  race: z.string().optional(), // not sure if this is the correct name https://en.wikipedia.org/wiki/Race_and_health
});

export type Patient = z.infer<typeof PatientSchema>;