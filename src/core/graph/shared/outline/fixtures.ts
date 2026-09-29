import { FIXED_CLOSE, FIXED_OPEN, outlineSkeleton } from "./segments.js";

/** Well-formed tag-delimited outline for tests: skeleton, each heading plus one content line. Shared so a skeleton change breaks one fixture. */
export function taggedOutlineFixture(
  opts: { anamnesisCategories?: string[] | undefined; body?: string } = {}
): string {
  const body = opts.body ?? "Some content.";
  return outlineSkeleton(opts)
    .map((heading) => `${FIXED_OPEN}${heading}${FIXED_CLOSE}\n${body}`)
    .join("\n\n");
}
