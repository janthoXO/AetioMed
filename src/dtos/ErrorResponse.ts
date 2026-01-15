import z from "zod";

export const ErrorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.string().optional(),
  }),
});

export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;