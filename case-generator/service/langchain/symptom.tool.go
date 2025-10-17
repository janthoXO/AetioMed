package langchain

import (
	"case-generator/models"
	"case-generator/utils"
	"case-generator/service"
	"context"
	"encoding/json"
	"fmt"

	log "github.com/sirupsen/logrus"
)

// GenerateSymptomsTool generates symptoms for the patient
type GenerateSymptomsTool struct {
	ctx        *service.CaseContext
	llmService *service.LLMService
}

func NewGenerateSymptomsTool(ctx *service.CaseContext, llmService *service.LLMService) *GenerateSymptomsTool {
	return &GenerateSymptomsTool{ctx: ctx, llmService: llmService}
}

func (t *GenerateSymptomsTool) Name() string {
	return "GenerateSymptoms"
}

func (t *GenerateSymptomsTool) Description() string {
	return "Generates realistic symptoms for the patient. Input should be empty or 'generate'. Returns the list of generated symptoms."
}

func (t *GenerateSymptomsTool) Call(ctx context.Context, input string) (string, error) {
	log.Debugf("GenerateSymptomsTool called with %+v\n %s", t.ctx, input)

	prompt := fmt.Sprintf(`Generate realistic symptoms for a patient with %s.
Context symptoms: %+v
Treatment reason: %s

Return ONLY a JSON object: 
[
	// Array of symptom objects
	{
		"name": "symptom in layman terms",
		"medical_name": "medical terminology",
		"description": "how it manifests",
		"severity": "mild|moderate|severe",
		"frequency": "rare|uncommon|common|very_common"
	}
]
`, t.ctx.DiseaseName, t.ctx.Symptoms, t.ctx.PatientPresentation.TreatmentReason)

	response, err := t.llmService.Generate(ctx, prompt)
	if err != nil {
		return "", fmt.Errorf("failed to generate symptoms: %w", err)
	}
	jsonArray, err := utils.ExtractJsonArray(response)
	if err != nil {
		return "", fmt.Errorf("failed to parse symptoms: %w", err)
	}

	var symptoms []models.Symptom
	for _, symptomDict := range jsonArray {
		var symptom models.Symptom
		if err := symptom.FromDict(symptomDict); err == nil {
			symptoms = append(symptoms, symptom)
		}
	}
	t.ctx.PatientPresentation.Symptoms = symptoms
	symptomsJSON, _ := json.Marshal(symptoms)
	return fmt.Sprintf("Generated %d symptoms: %s", len(symptoms), string(symptomsJSON)), nil
}
