export type PickNested<T, K extends keyof T, NestedK extends keyof T[K]> = {
  [Key in K]: Pick<T[Key], NestedK>;
};
