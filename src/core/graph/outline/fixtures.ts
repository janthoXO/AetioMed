import { FIXED_CLOSE, FIXED_OPEN, outlineSkeleton } from "./segments.js";

/**
 * A well-formed tag-delimited outline for tests (#159): the server-owned
 * skeleton, each heading followed by one line of content. Anything that
 * scripts an outline LLM response uses this, so a skeleton change breaks
 * one fixture instead of every test that fakes the outline call.
 */
export function taggedOutlineFixture(
  opts: { anamnesisCategories?: string[] | undefined; body?: string } = {}
): string {
  const body = opts.body ?? "Some content.";
  return outlineSkeleton(opts)
    .map((heading) => `${FIXED_OPEN}${heading}${FIXED_CLOSE}\n${body}`)
    .join("\n\n");
}
