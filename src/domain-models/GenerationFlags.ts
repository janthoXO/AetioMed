export enum GenerationFlags {
  TreatmentReason = 1 << 0, // 1
  Anamnesis = 1 << 1, // 2

  All = TreatmentReason | Anamnesis,
}

export const GenerationFlagKeys = Object.keys(GenerationFlags).filter((k) =>
  isNaN(Number(k))
) as [keyof typeof GenerationFlags, ...(keyof typeof GenerationFlags)[]];

export type GenerationFlagString = keyof typeof GenerationFlags;

/**
 * Convert an array of flag names to a bitmap
 */
export function flagStringsToBitmap(flags: GenerationFlagString[]): number {
  let bitmap = 0;
  for (const flag of flags) {
    bitmap |= GenerationFlags[flag];
  }
  return bitmap;
}

/**
 * Check if a specific flag is set in the bitmap
 */
export function hasFlag(bitmap: number, flag: GenerationFlags): boolean {
  return (bitmap & flag) !== 0;
}
