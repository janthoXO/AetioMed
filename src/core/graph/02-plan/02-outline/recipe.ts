import z from "zod";
import type { Diagnosis } from "@/core/graph/shared/domain/Diagnosis.js";
import type { Difficulty } from "@/core/graph/shared/domain/Difficulty.js";

/**
 * Case recipe (#216): dice the server rolls once per case before the outline
 * exists, like `difficulty` but random. Code decides whether the presentation
 * carries a diagnostic label and how it relates to the true diagnosis; the LLM
 * only writes it. Read by the outline generator (`instruction`) and judge
 * (`rubric`) only; every later node sees just the outline text. Never returned
 * to the client.
 */
export const LabelSchema = z.object({
  source: z.enum(["referral", "patient"]),
  class: z.enum(["correct", "partial", "wrong"]),
  partialType: z
    .enum(["too_broad", "same_organ", "finding", "complication"])
    .optional(),
});
export type Label = z.infer<typeof LabelSchema>;
type PartialType = NonNullable<Label["partialType"]>;

/** v1: at most one label. An array so two disagreeing labels later are a table change. */
export const RecipeSchema = z.array(LabelSchema);
export type Recipe = z.infer<typeof RecipeSchema>;

type Weights<K extends string> = Record<K, number>;

// Probabilities: #212 (Brod 2025, Lohr 2017). Easy never rolls a wrong label.
const SOURCE: Record<Difficulty, Weights<"none" | Label["source"]>> = {
  easy: { none: 0.55, referral: 0.3, patient: 0.15 },
  medium: { none: 0.4, referral: 0.3, patient: 0.3 },
  hard: { none: 0.25, referral: 0.4, patient: 0.35 },
};

const CLASS: Record<
  Label["source"],
  Record<Difficulty, Weights<Label["class"]>>
> = {
  referral: {
    easy: { correct: 0.6, partial: 0.4, wrong: 0 },
    medium: { correct: 0.45, partial: 0.3, wrong: 0.25 },
    hard: { correct: 0.35, partial: 0.35, wrong: 0.3 },
  },
  patient: {
    easy: { correct: 0.5, partial: 0.5, wrong: 0 },
    medium: { correct: 0.3, partial: 0.3, wrong: 0.4 },
    hard: { correct: 0.25, partial: 0.3, wrong: 0.45 },
  },
};

// A lay patient names a broad category or a neighbour, not a finding or a
// complication with its wrong cause: those need a doctor's referral.
const PARTIAL_TYPES: Record<Label["source"], PartialType[]> = {
  referral: LabelSchema.shape.partialType.unwrap().options,
  patient: ["too_broad", "same_organ"],
};

function pick<K extends string>(weights: Weights<K>, r: number): K {
  const entries = Object.entries(weights) as [K, number][];
  for (const [key, weight] of entries) {
    if (r < weight) return key;
    r -= weight;
  }
  return entries.at(-1)![0];
}

export function roll(difficulty: Difficulty, random: () => number): Recipe {
  const source = pick(SOURCE[difficulty], random());
  if (source === "none") return [];
  const labelClass = pick(CLASS[source][difficulty], random());
  return [
    {
      source,
      class: labelClass,
      ...(labelClass === "partial" && {
        partialType:
          PARTIAL_TYPES[source][
            Math.floor(random() * PARTIAL_TYPES[source].length)
          ],
      }),
    },
  ];
}

const PLACE: Record<Label["source"], string> = {
  referral: `In the Chief complaint section, the patient arrives with a referral from their general practitioner (who referred, when, why) that states a suspected diagnosis, worded as a suspicion ("V.a. …", "suspected …").`,
  patient: `In the Anamnesis section, in the category about the current complaint, the patient says in their own lay words what they believe they have (e.g. "I read online it might be …"), as a belief, not a diagnosis.`,
};

/** How the label relates to the true diagnosis; shared by instruction and rubric. */
function relation(label: Label, diagnosis: Diagnosis): string {
  switch (label.class) {
    case "correct":
      return `The label is the true diagnosis itself: "${diagnosis.name}" (a patient may use a lay term for it).`;
    case "wrong":
      return `The label is a different diagnosis that plausibly explains the leading symptom (a look-alike) — not the true diagnosis, nor a synonym, parent category, subtype or complication of it.`;
    case "partial":
      return {
        too_broad: `The label is a broader category that contains the true diagnosis, not the true diagnosis itself (e.g. "acute coronary syndrome" for NSTEMI).`,
        same_organ: `The label is a different disease of the same organ or region as the true diagnosis (e.g. cholecystitis for pancreatitis).`,
        finding: `The label is a finding the true diagnosis really produces, missing its cause (e.g. pneumonia for bronchial carcinoma).`,
        complication: `The label is a complication the patient really has, attributed to the wrong cause (e.g. "heart failure due to coronary artery disease" for aortic stenosis).`,
      }[label.partialType ?? "too_broad"];
  }
}

const NO_LABEL = `No diagnostic label: no referral suspicion and no self-diagnosis by the patient for the current complaint. A referral, if any, states only symptoms (e.g. "unclear dyspnoea").`;

/** Outline generator's "Diagnostic label" section: replaces the old "never name the diagnosis" rule. */
export function instruction(recipe: Recipe, diagnosis: Diagnosis): string {
  const rules = recipe.length
    ? recipe.flatMap((label) => [
        PLACE[label.source],
        relation(label, diagnosis),
        `Word the label the same way whether it is right or wrong; never state it as established, treated or monitored.`,
        ...(label.class === "correct"
          ? []
          : [
              `The presentation may contain a fact that does not fit the label, or leave the refutation to the workup; the Procedures strategy keeps every result consistent with the true diagnosis.`,
            ]),
      ])
    : [NO_LABEL];
  return [
    ...rules,
    `Apart from this, the true diagnosis is never named (no name, synonym or abbreviation) in Patient, Chief complaint or Anamnesis, and never stated as known, treated or monitored. Comorbidities and family history are free.`,
    `Record in General which label you placed, where, and how it relates to the true diagnosis.`,
  ]
    .map((rule) => `- ${rule}`)
    .join("\n");
}

/** Outline judge's "Diagnostic label" rule: the recipe realised exactly. */
export function rubric(recipe: Recipe, diagnosis: Diagnosis): string {
  const expected = recipe.length
    ? recipe
        .map(
          (
            label
          ) => `Expected: ${PLACE[label.source]} ${relation(label, diagnosis)}
Check in this order: find the label in its place and quote it; check it is worded as a suspicion or belief, never as established, treated or monitored; check its relation to the target diagnosis is exactly the expected one — a lay term, synonym or abbreviation of the target counts as the target itself. Reject if the label is missing, in another place, stated as established, or its relation does not match.`
        )
        .join("\n")
    : `Expected: ${NO_LABEL} Reject a referral suspicion or patient self-diagnosis.`;
  return `${expected}
Apart from this label, the Patient, Chief complaint and Anamnesis sections must not say or imply that THIS patient has the target diagnosis (e.g. "diagnosed with X", "known X", a medication or monitoring only X explains).`;
}
