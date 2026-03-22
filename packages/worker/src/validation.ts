import type { GenericSchema, InferOutput } from "valibot";
import { flatten, safeParse } from "valibot";

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
