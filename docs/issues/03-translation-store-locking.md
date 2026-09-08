# 03 — Translation store: provenance, per-key locking, shared retries

**Depends on:** 01 · **Blocks:** 09, 12
**Design ref:** `architecture-target.md` §5.2, §7.1

## Why

**This is a live bug, not a refactor.** LLM-filled translations are currently non-deterministic under concurrency, and there is no way to tell a machine-generated medical term from a clinician-reviewed one.

## Current state

### The concurrency bug

`03repo/translationStore.ts`, `translateMissing()` (~lines 167-204):

```ts
const dedupKey = `${lang}\0${[...missing].sort().join("\0")}`;
let pending = inFlight.get(dedupKey);
```

The in-flight key is over the **whole missing set**. Two concurrent requests needing `{A,B}` and `{B,C}` produce different dedup keys, so **both** call the LLM, **both** generate a value for `B`, and **both** `save()` — which upserts. Last writer wins, and the two calls can disagree. Deduplication only works when two requests are missing exactly the same set.

### No provenance

`03repo/schema.ts:24-40` — the `translation` table is `(domain, lang, english, translated)` with a composite primary key. Nothing distinguishes a YAML-curated row from an LLM-generated one.

## Task

### 1. `source` column

Add `source: 'curated' | 'generated'` to `translation`. YAML sync writes `curated`; LLM fill writes `generated`. Generate the migration with `pnpm db:generate`. Backfill existing rows as `curated` — that is the safe default, since it means "do not silently trust as reviewed" only where we know it is generated.

Add a CLI (or an `npm` script) listing `generated` rows per domain and language, so they can be reviewed and promoted into YAML.

### 2. Lock per key

Replace the set-keyed in-flight map with a per-key one:

```ts
const inFlight = new Map<string, Promise<string>>(); // key: `${domain}\0${lang}\0${english}`
```

Algorithm for `translateMissing(keys, lang, generate, ctx)`:

1. Partition `keys` into cache hits, keys already in flight, and keys to claim.
2. **Claim atomically** — register a promise for each claimed key _before_ any `await`, so a concurrently-entering request sees them.
3. Issue **one** `generate()` call for the claimed subset only.
4. Resolve each claimed key's promise from the response.
5. `await` the in-flight promises for keys claimed by someone else, and merge.

### 3. First-writer-wins in the database

Persist with `INSERT ... ON CONFLICT DO NOTHING`, then **read back the stored row** and return that, not the locally generated string. This makes convergence hold across processes and replicas, not just within one event loop. Combined with the `source` column: never regenerate a key that already exists, whatever its source.

### 4. Retry semantics — the part to get right

The shared promise must not turn a transient failure into a stampede, nor into a spurious error for every waiter:

- **Retries live inside the shared promise.** The registered promise wraps the _whole_ retry loop, not a single attempt. Everyone awaiting that key receives the successful retry's result.
- **On ultimate failure, reject all waiters _and_ delete the in-flight entry**, so the next request starts fresh. Do not leave a rejected promise cached — `extensions/persistency/redis.ts` has exactly that bug today (a failed connect caches `null` forever); do not reproduce it.
- **Partial batch success is per key.** One `generate()` call may cover several keys and return only some. Resolve the promises for keys that came back; put the missing ones into the _next_ attempt. One stubborn term must not fail its batch-mates.
- **A fill failure is never fatal to the request.** The caller falls back to the English key, exactly as labels do (design §8). A missing translation degrades presentation; it must not fail a generation.

Reuse `utils/retry.ts` for the loop rather than hand-rolling one.

## Acceptance criteria

- [ ] Migration adds `source`; `pnpm db:generate` output is committed
- [ ] Concurrency test: two overlapping `translateMissing` calls with a `generate` spy → the spy is called **once per key**, both callers get the same value
- [ ] Retry test: `generate` fails twice then succeeds → **all** waiters receive the success, `generate` attempt count matches the retry policy
- [ ] Failure test: `generate` always fails → all waiters reject, the in-flight entry is cleared, a subsequent call retries (does not inherit the cached rejection)
- [ ] Partial test: `generate` returns 2 of 3 keys → the 2 resolve, the third is retried
- [ ] Fallback test: a permanently failing fill still yields a usable result (English key) at the call site
- [ ] Cross-process behaviour: a second writer's value does not overwrite the first (assert via `ON CONFLICT DO NOTHING` + read-back)

## Notes

Determinism holds **per deployment**, not across deployments — two installs can generate different German names for the same procedure. If cross-deployment stability is ever needed, the answer is curated YAML, not better locking. Say so in the README.

## Out of scope

Which languages exist (09), the defined/rest translation split (12).
