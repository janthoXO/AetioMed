export type PickNested<T, K extends keyof T, NestedK extends keyof T[K]> = {
  [Key in K]: Pick<T[Key], NestedK>;
};

/** Runtime pick: create a new object with only the specified keys. */
export function pick<T extends object, K extends keyof T>(
  obj: T,
  keys: K[]
): Pick<T, K> {
  const result = {} as Pick<T, K>;
  for (const k of keys) {
    result[k] = obj[k];
  }
  return result;
}
