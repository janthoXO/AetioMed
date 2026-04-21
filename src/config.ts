import dotenv from "dotenv";
import z from "zod";

dotenv.config();

export const EnvSchema = z
  .object({
    PORT: z.coerce.number().default(3030),

    FEATURES: z
      .string()
      .default("")
      .transform((val) => new Set(val.split(","))),
  })
  .transform((env) => {
    const { PORT, FEATURES } = env;

    return {
      port: PORT,
      features: FEATURES,
    };
  });

export type Config = z.output<typeof EnvSchema>;

export const config = EnvSchema.parse(process.env);
