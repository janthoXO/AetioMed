export enum GenerationFlags {
  ChiefComplaint = 1 << 0, // 1
  Anamnesis = 1 << 1, // 2

  All = ChiefComplaint | Anamnesis,
}

export const GenerationFlagKeys = Object.keys(GenerationFlags).filter((k) =>
  isNaN(Number(k))
) as [keyof typeof GenerationFlags, ...(keyof typeof GenerationFlags)[]];

export type GenerationFlagString = keyof typeof GenerationFlags;

/**
 * Check if a specific flag is set in the bitmap
 */
export function hasFlag(bitmap: number, flag: GenerationFlags): boolean {
  return (bitmap & flag) !== 0;
}

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
 * Convert a bitmap to an array of flag names
 */
export function bitmapToFlagStrings(bitmap: number): GenerationFlagString[] {
  const flags: GenerationFlagString[] = [];
  for (const flag of Object.values(GenerationFlags)) {
    if (typeof flag !== typeof "number") {
      continue;
    }
    if (!hasFlag(bitmap, flag as GenerationFlags)) {
      continue;
    }

    flags.push(flag as GenerationFlagString);
  }
  return flags;
}
