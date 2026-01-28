import { buildTranslationGraph } from "./index.js";
import { type Case } from "@/domain-models/Case.js";
import dotenv from "dotenv";

dotenv.config();

async function testTranslation() {
  console.log("Starting Translation Graph Test...");

  const mockCase: Case = {
    chiefComplaint: "Severe headache and sensitivity to light",
    anamnesis: [
      {
        category: "History of Present Illness",
        answer: "Patient reports a throbbing headache starting 2 hours ago.",
      },
      {
        category: "Medications",
        answer: "Taking ibuprofen occasionally.",
      },
    ],
  };

  try {
    const result = await buildTranslationGraph().invoke({
      case: mockCase,
      language: "German",
    });

    console.log("Translation Result:", JSON.stringify(result.case, null, 2));

    // Simple assertion checks
    if (!result.case?.anamnesis || result.case.anamnesis.length === 0) {
      throw new Error("Anamnesis missing in result");
    }

    // Check first item category
    if (result.case.anamnesis[0]!.category !== "Krankheitsverlauf") {
      console.error(
        `Expected 'Krankheitsverlauf', got '${result.case.anamnesis[0]!.category}'`
      );
    } else {
      console.log("Assertion Passed: Category translated correctly.");
    }
  } catch (error) {
    console.error("Test Failed:", error);
  }
}

testTranslation();
