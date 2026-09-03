import fs from "fs";
import path from "path";
import yaml from "yaml";

// Usage: pnpm tsx scripts/extract-icd11.ts

const ICD_API_BASE_URL =
  process.env.ICD_API_URL || "http://localhost:3000/icd/release/11/mms";
const OUTPUT_FILE = path.resolve(process.cwd(), "data/diagnosis.yml");
const HEADERS = {
  Accept: "application/json",
  "Accept-Language": "en",
  "API-Version": "v2",
};

const maxDepth = process.env.MAX_DEPTH ? parseInt(process.env.MAX_DEPTH) : 5;
const delay = (ms: number) => new Promise((res) => setTimeout(res, ms));

async function fetchNode(url: string) {
  let retries = 3;
  const localUrl = url.replace("http://id.who.int", "http://localhost:3000");
  while (retries > 0) {
    try {
      const res = await fetch(localUrl, { headers: HEADERS });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      retries--;
      if (retries === 0) throw e;
      await delay(500);
    }
  }
}

async function fetchIcd11() {
  console.log(`Fetching from ${ICD_API_BASE_URL}...`);
  const root = await fetchNode(ICD_API_BASE_URL);
  if (!root || !root.release) {
    throw new Error(`Failed to fetch root ICD codes`);
  }

  const latestReleaseUrl = root.latestRelease || root.release[0];
  const releaseRoot = await fetchNode(latestReleaseUrl);
  if (!releaseRoot) throw new Error(`Failed to fetch latest release`);

  const diagnoses: Map<string, { code: string; names: string[] }> = new Map();
  const visited = new Set<string>();

  const queue: { url: string; depth: number }[] = releaseRoot.child.map(
    (url: string) => ({ url, depth: 1 })
  );

  console.log(`Starting crawl of ${queue.length} root children`);
  let count = 0;

  while (queue.length > 0) {
    const batch = queue.splice(0, 10);
    const results = await Promise.all(
      batch.map((item) =>
        fetchNode(item.url).then((data) => ({ data, depth: item.depth }))
      )
    );

    for (const { data, depth } of results) {
      if (!data || visited.has(data["@id"])) continue;
      visited.add(data["@id"]);
      count++;

      if (data.code && data.title?.["@value"]) {
        diagnoses.set(data.code, {
          code: data.code,
          names: [data.title["@value"]],
        });
      }

      if (data.child && depth < maxDepth) {
        for (const childUrl of data.child) {
          if (!visited.has(childUrl)) {
            queue.push({ url: childUrl, depth: depth + 1 });
          }
        }
      }
    }

    if (count % 50 === 0 || count % 50 < batch.length) {
      console.log(
        `Processed ${count} nodes, queue size: ${queue.length}, found diagnoses: ${diagnoses.size}`
      );
    }
  }

  console.log(`Finished crawling. Found ${diagnoses.size} diagnoses.`);
  fs.writeFileSync(OUTPUT_FILE, yaml.stringify(diagnoses));
  console.log(`Wrote to ${OUTPUT_FILE}`);
}

fetchIcd11().catch(console.error);
