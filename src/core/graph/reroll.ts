import type { ContentPart } from "@/core/graph/shared/domain/ContentPart.js";
import type { Diagnosis } from "@/core/graph/shared/domain/Diagnosis.js";
import { refOfKey } from "@/core/graph/shared/domain/ProcedureTree.js";
import type { OutlineSections } from "@/core/graph/shared/outline/segments.js";
import { renderPlan } from "@/core/graph/shared/modality/pipeline.js";
import type {
  ModalityField,
  ModalityRegistries,
} from "@/core/graph/shared/modality/registry.js";
import type { ModalityPlan } from "@/core/graph/shared/modality/ports.js";
import {
  boundLanguage,
  requestLanguage,
  revisionSection,
} from "@/core/graph/shared/prompt/prompt.js";
import {
  CHIEF_COMPLAINT_UNIT_KEY,
  planChiefComplaint,
} from "@/core/graph/04-case/01-presentation/chief-complaint/gateway.js";
import { getRequestContext } from "@/core/graph/utils/context.js";
import { planAnamnesis } from "@/core/graph/04-case/01-presentation/anamnesis/gateway.js";
import { planProcedureResults } from "@/core/graph/04-case/02-procedures/results.gateway.js";
import { translateRestValues } from "@/core/graph/05-translate-out/gateway.js";
import type { GraphRuntime } from "./runtime.js";

/** One part to render again: recorded provider + input, current `alt`, optional wording `hint`. */
export type PartSource = {
  provider: string;
  input: unknown;
  alt: string;
  hint?: string | undefined;
};

/** A unit refine (#272): the author's request, the unit's current parts, the part pointed at. */
export type UnitRevision = {
  instruction: string;
  current: PartSource[];
  focus?: number | undefined;
};

/**
 * Below-field rerolls (#272), outside the compiled graphs: a unit re-plans
 * one plan unit (`plan_content` narrowed to it, then `render_parts`), a part
 * only renders again. Same gateways and `renderPlan` the graphs use.
 */
export function makeRerolls(
  runtime: GraphRuntime,
  registries: ModalityRegistries,
  sandwich: boolean
) {
  // As `assembleCaseGraphs`: planners write the working language.
  const generation: GraphRuntime = sandwich
    ? { ...runtime, languageOverride: "en" }
    : runtime;

  async function render(field: ModalityField, parts: ModalityPlan[string]) {
    const rendered = await renderPlan(
      registries[field],
      { unit: parts },
      getRequestContext(),
      runtime.log
    );
    return rendered.unit!;
  }

  /** Planner `alt` is working language; the client reads the request language. */
  async function altsOut(parts: ContentPart[]): Promise<ContentPart[]> {
    const language = requestLanguage();
    if (!sandwich || !language || language === "en") return parts;
    const translated = await translateRestValues(
      runtime,
      {
        values: Object.fromEntries(parts.map((p, i) => [String(i), p.alt])),
        language,
      },
      getRequestContext()
    );
    return parts.map((p, i) => ({ ...p, alt: translated[String(i)] ?? p.alt }));
  }

  return {
    /** Part reroll: same provider, input and `alt`; only `value` new. */
    renderParts(
      field: ModalityField,
      parts: PartSource[]
    ): Promise<ContentPart[]> {
      return render(field, parts);
    },

    /** Whether `provider` renders text in `field`: only those take a render-level refine. */
    isText(field: ModalityField, provider: string): boolean {
      return (
        registries[field]
          .find((p) => p.id === provider)
          ?.mime.startsWith("text/") ?? false
      );
    },

    /**
     * Unit reroll: re-plan one chief complaint, anamnesis category or
     * procedure result (English unit key, `source.unit`) from the outline,
     * render it. With a `revision` (plan-level refine) the planner sees the
     * current parts and the request; when the part count holds, only parts
     * that differ are rendered, returned with their indices as `changed`.
     */
    async replanUnit(
      field: ModalityField,
      unit: string,
      opts: {
        diagnosis: Diagnosis;
        outlineSections: OutlineSections;
        revision?: UnitRevision | undefined;
      }
    ): Promise<{ parts: ContentPart[]; changed?: number[] }> {
      const { outlineSections: sections, revision } = opts;
      const context = getRequestContext();
      const language = boundLanguage(generation);
      const prompt = revision && revisionSection(revision);
      const planned =
        field === "chiefComplaint"
          ? (
              await planChiefComplaint(
                generation,
                language,
                {
                  patient: sections.patient,
                  chiefComplaint: sections.chiefComplaint,
                },
                registries.chiefComplaint,
                context,
                prompt
              )
            )[CHIEF_COMPLAINT_UNIT_KEY]!
          : field === "anamnesis"
            ? (
                await planAnamnesis(
                  generation,
                  language,
                  { patient: sections.patient, anamnesis: sections.anamnesis },
                  registries.anamnesis,
                  context,
                  [unit],
                  prompt
                )
              )[unit]!
            : (
                await planProcedureResults(
                  generation,
                  language,
                  {
                    patient: sections.patient,
                    chiefComplaint: sections.chiefComplaint,
                    anamnesis: sections.anamnesis,
                  },
                  opts.diagnosis,
                  [refOfKey(unit)],
                  registries.procedureResult,
                  sections.procedures,
                  context,
                  prompt
                )
              )[0]!.parts;
      const current = revision?.current ?? [];
      if (current.length === 0 || planned.length !== current.length)
        return { parts: await altsOut(await render(field, planned)) };
      const changed = planned.flatMap((p, i) =>
        p.provider === current[i]!.provider &&
        p.alt === current[i]!.alt &&
        JSON.stringify(p.input ?? {}) ===
          JSON.stringify(current[i]!.input ?? {})
          ? []
          : [i]
      );
      if (changed.length === 0) return { parts: [], changed };
      return {
        parts: await altsOut(
          await render(
            field,
            changed.map((i) => planned[i]!)
          )
        ),
        changed,
      };
    },
  };
}

export type Rerolls = ReturnType<typeof makeRerolls>;
