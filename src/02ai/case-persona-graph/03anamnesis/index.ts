import { END, START, StateGraph } from "@langchain/langgraph";
import { GlobalStateSchema } from "../state.js";
import z from "zod";
import {
  generateAnamnesisCoT as generateAnamnesisCoTService,
  generateAnamnesisOneShot,
} from "@/02services/anamnesis.service.js";

const AnamnesisGraphStateSchema = GlobalStateSchema.pick({
  diagnosis: true,
  userInstructions: true,
  anamnesisCategories: true,
  case: true,
  symptoms: true,
}).extend({
  cot: z.string(),
});

type AnamnesisGraphState = z.infer<typeof AnamnesisGraphStateSchema>;

async function generateAnamnesisCoT(
  state: AnamnesisGraphState
): Promise<Pick<AnamnesisGraphState, "cot">> {
  console.debug(
    "[AnamnesisGraph: generateAnamnesisCoT] Generating anamnesis CoT with LLM..."
  );
  state.cot = await generateAnamnesisCoTService(
    state.diagnosis,
    state.symptoms,
    state.case,
    state.userInstructions
  );
  return { cot: state.cot };
}

async function generateAnamnesis(
  state: AnamnesisGraphState
): Promise<Pick<AnamnesisGraphState, "case">> {
  console.debug(
    "[AnamnesisGraph: generateAnamnesis] Generating anamnesis with LLM..."
  );
  if (!state.case) {
    state.case = {};
  }
  state.case.anamnesis = await generateAnamnesisOneShot(
    state.diagnosis,
    state.symptoms,
    state.case,
    state.cot,
    state.userInstructions,
    state.anamnesisCategories
  );
  return { case: state.case };
}

export const anamnesisGraph = new StateGraph(AnamnesisGraphStateSchema)
  .addNode("anamnesis_cto_generate", generateAnamnesisCoT)
  .addNode("anamnesis_generate", generateAnamnesis)

  .addEdge(START, "anamnesis_cto_generate")
  .addEdge("anamnesis_cto_generate", "anamnesis_generate")
  .addEdge("anamnesis_generate", END)
  .compile();
