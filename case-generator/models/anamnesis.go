package models

import(
	"gitlab.lrz.de/ILVI/ilvi/ilvi-api/controller/dto"
)

type Anamnesis struct {
	dto.AnamnesisPayload
}

const AnamnesisExampleJSONArr = `[
	{
		"category": "category name",
		"answer": "patient's answer"
	}
] // containing the categories:
	// - Krankheitsverlauf
	// - Vorerkrankungen
	// - Medikamente
	// - Allergien
	// - Familienanamnese
	// - Kardiovaskuläre Risikofaktoren
	// - Sozial-/Berufsanamnese`
