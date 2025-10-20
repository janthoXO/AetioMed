package models

type Anamnesis struct {
	Category string  `json:"category"`
	Answer   string  `json:"answer"`
	TimeCost float64 `json:"timeCost"`
}

func (a *Anamnesis) FromDict(dict map[string]interface{}) {
	if val, ok := dict["category"].(string); ok {
		a.Category = val
	}
	if val, ok := dict["answer"].(string); ok {
		a.Answer = val
	}
	if val, ok := dict["timeCost"].(float64); ok {
		a.TimeCost = val
	}
}

const AnamnesisExampleJSONArr = `[
	{
		"category": "category name",
		"answer": "patient's answer",
		"timeCost": int (time cost in minutes)
	}
] // containing the categories:
	// - Krankheitsverlauf
	// - Vorerkrankungen
	// - Medikamente
	// - Allergien
	// - Familienanamnese
	// - Kardiovaskuläre Risikofaktoren
	// - Sozial-/Berufsanamnese`
	

const AnamnesisStructuredOutput = `{
"type": "object",
"properties": {
	"category": {
		"type": "string"
	},
	"answer": {
		"type": "string"
	},
	"timeCost": {
		"type": "string"
	}
}
}`

const AnamnesisStructuredOutputArray = "{\"type\":\"array\",\"items\":" + AnamnesisStructuredOutput + "}"

