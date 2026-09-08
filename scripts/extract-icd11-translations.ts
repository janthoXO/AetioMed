import fs from "fs";
import path from "path";
import yaml from "yaml";

// Usage: pnpm tsx scripts/extract-icd11-translations.ts

const ICD_API_BASE_URL =
  process.env.ICD_API_URL || "http://localhost:3000/icd/release/11/mms";
const OUTPUT_FILE = path.resolve(
  process.cwd(),
  "data/diagnosisTranslations.yml"
);

const maxDepth = process.env.MAX_DEPTH ? parseInt(process.env.MAX_DEPTH) : 5;
const delay = (ms: number) => new Promise((res) => setTimeout(res, ms));

async function fetchFromApi(url: string, language: string) {
  const localUrl = url.replace("http://id.who.int", "http://localhost:3000");
  const headers = {
    Accept: "application/json",
    "Accept-Language": language, // e.g. "en" or "de"
    "API-Version": "v2",
  };

  let retries = 3;
  while (retries > 0) {
    try {
      const response = await fetch(localUrl, { headers });
      if (response.status === 404) return null;
      if (!response.ok) {
        throw new Error(
          `Failed to fetch from ${language}: ${response.statusText}`
        );
      }
      return await response.json();
    } catch (e) {
      retries--;
      if (retries === 0) throw e;
      await delay(500);
    }
  }
}

async function extractTranslations() {
  console.log(`Starting translation extraction for ICD-11...`);

  // 1. Fetch the terminology
  const root = await fetchFromApi(ICD_API_BASE_URL, "en");
  if (!root || !root.release) throw new Error("No root release found");
  const latestReleaseUrl = root.latestRelease || root.release[0];

  const releaseRoot = await fetchFromApi(latestReleaseUrl, "en");
  if (!releaseRoot) throw new Error("Could not fetch release root");

  const translations: Record<string, string> = {};
  const visited = new Set<string>();

  const queue: { url: string; depth: number }[] = releaseRoot.child.map(
    (url: string) => ({ url, depth: 1 })
  );

  console.log(`Starting translation crawl of ${queue.length} root children`);
  let count = 0;

  while (queue.length > 0) {
    const batch = queue.splice(0, 10);
    const results = await Promise.all(
      batch.map(async (item) => {
        const [en, de] = await Promise.all([
          fetchFromApi(item.url, "en"),
          fetchFromApi(item.url, "de"),
        ]);
        return { en, de, depth: item.depth };
      })
    );

    for (const { en, de, depth } of results) {
      if (!en || !de || visited.has(en["@id"])) continue;
      visited.add(en["@id"]);
      count++;

      const enTitle = en.title?.["@value"];
      const deTitle = de.title?.["@value"];

      if (enTitle && deTitle) {
        translations[enTitle] = deTitle;
      }

      if (en.child && depth < maxDepth) {
        for (const childUrl of en.child) {
          if (!visited.has(childUrl)) {
            queue.push({ url: childUrl, depth: depth + 1 });
          }
        }
      }
    }

    if (count % 50 === 0 || count % 50 < batch.length) {
      console.log(
        `Processed ${count} nodes, queue size: ${queue.length}, translations count: ${Object.keys(translations).length}`
      );
    }
  }

  const outputFormat = {
    German: translations,
  };

  fs.writeFileSync(OUTPUT_FILE, yaml.stringify(outputFormat));
  console.log(`Finished extraction. Wrote to ${OUTPUT_FILE}`);
}

extractTranslations().catch(console.error);
