// The rule of the local models (the user's): at most the 3B class, counted from what Ollama reports.

/** The largest local model allowed, in billions of parameters (qwen2.5-coder:3b reports 3.1B). */
export const MAX_BILLIONS = 3.5;

/** Billions of parameters from Ollama's `parameter_size` ("3.1B", "494.03M") and the tag (`gemma4:e2b` is an
 * effective-2B model). */
export function billionsOf(name: string, parameters: string): number {
  const effective = name.match(/:e(\d+(?:\.\d+)?)b\b/i);
  if (effective) return Number(effective[1]);
  const m = parameters.match(/([\d.]+)\s*([BM])/i);
  return m ? Number(m[1]) / (m[2].toUpperCase() === 'M' ? 1000 : 1) : NaN;
}
