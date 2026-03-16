import { END, START, StateGraph } from "@langchain/langgraph";
import { GlobalStateSchema } from "../state.js";
import z from "zod";
import {
  generateSymptomsOneShot,
  SymptomsRelatedToDiseaseIcd,
} from "@/02services/symptoms.service.js";

const SymptomsGraphStateSchema = GlobalStateSchema.pick({
  diagnosis: true,
  userInstructions: true,
  symptoms: true,
});

type SymptomsGraphState = z.infer<typeof SymptomsGraphStateSchema>;

function retrieveSymptomsUMLS(
  state: SymptomsGraphState
): Pick<SymptomsGraphState, "symptoms"> {
  console.debug(
    "[SymptomsGraph: retrieveSymptomsUMLS] Retrieving symptoms from UMLS..."
  );
  if (!state.diagnosis.icd) {
    return { symptoms: state.symptoms };
  }

  state.symptoms = SymptomsRelatedToDiseaseIcd(state.diagnosis.icd);
  return { symptoms: state.symptoms };
}

async function generateSymptoms(
  state: SymptomsGraphState
): Promise<Pick<SymptomsGraphState, "symptoms">> {
  console.debug(
    "[SymptomsGraph: generateSymptoms] Generating symptoms with LLM..."
  );
  state.symptoms = await generateSymptomsOneShot(
    state.diagnosis,
    state.userInstructions,
    state.symptoms
  );
  return { symptoms: state.symptoms };
}

export const symptomsGraph = new StateGraph(SymptomsGraphStateSchema)
  .addNode("symptoms_umls", retrieveSymptomsUMLS)
  .addNode("symptoms_generate", generateSymptoms)

  .addEdge(START, "symptoms_umls")
  .addEdge("symptoms_umls", "symptoms_generate")
  .addEdge("symptoms_generate", END)
  .compile();
