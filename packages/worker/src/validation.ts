import type { GenericSchema, InferOutput } from "valibot";
import { flatten, object, pipe, safeParse, string, uuid } from "valibot";

export const documentIdParamSchema = object({
  id: pipe(string(), uuid()),
});

export function validateWithSchema<TSchema extends GenericSchema>(
  schema: TSchema,
  input: unknown,
) {
  const result = safeParse(schema, input);
  if (result.success) {
    return {
      success: true as const,
      output: result.output as InferOutput<TSchema>,
    };
  }

  return {
    success: false as const,
    issues: flatten(result.issues),
  };
}
