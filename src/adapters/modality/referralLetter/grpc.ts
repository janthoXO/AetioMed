import z from "zod";
import { retry } from "@/core/graph/shared/prompt/retry.js";
import type { Language } from "@/core/graph/shared/domain/Language.js";
import { contractPath, createGrpcService } from "../grpc.js";
import type { ReferralLetter } from "./draft.js";

/** Copy of AetioReferral's contract (its `proto/aetioreferral/v1/referral.proto` is the source of truth). */
export const REFERRAL_PROTO = contractPath("aetioreferral/v1/referral.proto");

const SERVICE = "aetioreferral.v1.ReferralService";
/** Typst renders a letter in well under a second; generous for a cold start. */
const DEADLINE_MS = 30_000;

/** Renders one drafted referral letter as a PDF in `language`. */
export type ReferralLetterRenderer = (
  letter: ReferralLetter,
  language: Language,
  signal?: AbortSignal
) => Promise<Uint8Array<ArrayBuffer>>;

/** `RenderLetter`'s reply, only the PDF is read. Parsed, never cast. */
const RenderedLetterSchema = z.object({ pdf: z.instanceof(Uint8Array) });

/** Startup check: AetioReferral reachable. Throws otherwise. */
export async function probeReferralGrpc(address: string): Promise<void> {
  const service = createGrpcService(REFERRAL_PROTO, SERVICE, address, 5000);
  try {
    await retry(() => service.ready(), 2, 1000);
  } finally {
    service.close();
  }
}

/**
 * `ReferralLetterRenderer` over AetioReferral's gRPC `RenderLetter`. One
 * retry. `noPatient` keeps the letter from naming a patient the case's own
 * `patient` could contradict; unset fields stay empty or are generated.
 */
export function createGrpcReferralLetterRenderer(
  address: string
): ReferralLetterRenderer {
  const { call } = createGrpcService(
    REFERRAL_PROTO,
    SERVICE,
    address,
    DEADLINE_MS
  );
  return async (
    {
      sender_name,
      recipient_specialty,
      reason,
      urgent,
      suspected_diagnosis,
      history,
      findings,
    },
    language,
    signal
  ) => {
    const letter = {
      language, // ISO 639-1 is a valid BCP 47 tag
      recipientSpecialty: recipient_specialty,
      reason,
      urgent,
      noPatient: true,
      // Unnamed referrer: AetioReferral makes one up.
      sender: sender_name ? { name: sender_name } : {},
      ...(suspected_diagnosis !== null && {
        suspectedDiagnosis: suspected_diagnosis,
      }),
      ...(history !== null && { history }),
      ...(findings !== null && { findings }),
    };
    const { pdf } = RenderedLetterSchema.parse(
      await retry(() => call("RenderLetter", { letter }, signal), 1, 500)
    );
    return new Uint8Array(pdf); // copy: a Buffer may share a pooled ArrayBuffer
  };
}
