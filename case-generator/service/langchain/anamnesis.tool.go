package langchain

import (
	"case-generator/models"
	"case-generator/service"
	"case-generator/utils"
	"context"
	"encoding/json"
	"fmt"

	log "github.com/sirupsen/logrus"
)

// GenerateAnamnesisTool generates anamnesis items
type GenerateAnamnesisTool struct {
	ctx        *service.CaseContext
	llmService service.LLMService
}

func NewGenerateAnamnesisTool(ctx *service.CaseContext, llmService service.LLMService) *GenerateAnamnesisTool {
	return &GenerateAnamnesisTool{ctx: ctx, llmService: llmService}
}

func (t *GenerateAnamnesisTool) Name() string {
	return "GenerateAnamnesis"
}

func (t *GenerateAnamnesisTool) Description() string {
	return "Generates anamnesis (medical history) for the patient. Input should be empty or 'generate'. Returns the generated anamnesis items."
}

func (t *GenerateAnamnesisTool) Call(ctx context.Context, input string) (string, error) {
	log.Debugf("GenerateAnamnesisTool called with %+v\n %s", t.ctx, input)

	prompt := fmt.Sprintf(`Generate realistic anamnesis (medical history) for a patient with %s.
Context 
symptoms: %+v
Treatment reason: %s

Generate items covering: personal history, family history, social history, medications, allergies, review of systems.

Return ONLY a JSON array:
[
  {
    "category": "category name",
    "answer": "patient's answer",
    "timeCost": 2.5
  }
]

TimeCost is in minutes (1-5).`, t.ctx.DiseaseName, t.ctx.Symptoms, t.ctx.PatientPresentation.TreatmentReason)

	response, err := t.llmService.Generate(ctx, prompt, "")
	if err != nil {
		return "", fmt.Errorf("failed to generate anamnesis: %w", err)
	}

	anamnesisData, err := utils.ExtractJsonArray(response)
	if err != nil {
		return "", fmt.Errorf("failed to parse anamnesis: %w", err)
	}

	var anamnesis []models.Anamnesis
	for _, item := range anamnesisData {
		var a models.Anamnesis
		a.FromDict(item)
		anamnesis = append(anamnesis, a)
	}

	t.ctx.Anamnesis = anamnesis
	anamnesisJSON, _ := json.Marshal(anamnesis)
	return fmt.Sprintf("Generated %d anamnesis items: %s", len(anamnesis), string(anamnesisJSON)), nil
}
