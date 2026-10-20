// Floating-point arithmetic must not reject a rounded value exactly at a tolerance boundary.
export const ROUNDING_EPSILON = 1e-12;
/** Live Jev responses round probabilities to hundredths (observed sum 0.99). */
export const roundedHundredths = (values: number[]): boolean => values.every(n => Math.abs(n * 100 - Math.round(n * 100)) <= ROUNDING_EPSILON);
/** The named choice is the top of the distribution. jev-1.14.0 occasionally names one a hundredth below the rounded
 * maximum (low-confidence, many options), so rounded distributions allow that one step; full precision stays strict.
 * The one check for Jev response validation and every reader of a choice answer. */
export function choiceAtTop(probabilities: Record<string, number>, choice: string): boolean {
  const values = Object.values(probabilities), gap = roundedHundredths(values) ? 0.01 : 0.00001;
  return Object.hasOwn(probabilities, choice) && values.every(p => p <= probabilities[choice] + gap + ROUNDING_EPSILON);
}
/** The named choice is the highest probability, with no rounding allowance: only such a choice can be confident.
 * A pick accepted by choiceAtTop below the top is a tie at the reported precision, never a confident answer. */
export const choiceIsTop = (probabilities: Record<string, number>, choice: string): boolean =>
  Object.hasOwn(probabilities, choice) && Object.values(probabilities).every(p => p <= probabilities[choice] + ROUNDING_EPSILON);
