package langchain

import (
	"case-generator/service"
	"case-generator/utils"
	"context"
	"fmt"

	log "github.com/sirupsen/logrus"
)

// GenerateTreatmentReasonTool generates the patient's chief complaint
type GenerateTreatmentReasonTool struct {
	ctx        *service.CaseContext
	llmService service.LLMService
}

func NewGenerateTreatmentReasonTool(ctx *service.CaseContext, llmService service.LLMService) *GenerateTreatmentReasonTool {
	return &GenerateTreatmentReasonTool{ctx: ctx, llmService: llmService}
}

func (t *GenerateTreatmentReasonTool) Name() string {
	return "GenerateTreatmentReason"
}

func (t *GenerateTreatmentReasonTool) Description() string {
	return "Generates a realistic treatment reason (chief complaint) for the patient. Input should be empty or 'generate'. Returns the generated treatment reason."
}

func (t *GenerateTreatmentReasonTool) Call(ctx context.Context, input string) (string, error) {
	log.Debugf("GenerateTreatmentReasonTool called with %+v\n %s", t.ctx, input)

	prompt := fmt.Sprintf(`Generate a realistic chief complaint (treatment reason) for a patient with %s.
Context symptoms: %+v
Anamnesis: %+v

Return ONLY a JSON object: {"treatmentReason": "the patient's complaint in their own words"}`,
		t.ctx.DiseaseName, t.ctx.Symptoms, t.ctx.Anamnesis)

	response, err := t.llmService.Generate(ctx, prompt)
	if err != nil {
		return "", fmt.Errorf("failed to generate treatment reason: %w", err)
	}
	jsonObject, err := utils.ExtractJsonObject(response)
	if err != nil {
		return "", fmt.Errorf("failed to parse treatment reason: %w", err)
	}

	if treatmentReason, ok := jsonObject["treatmentReason"].(string); ok {
		t.ctx.PatientPresentation.TreatmentReason = treatmentReason
		return fmt.Sprintf("Generated treatment reason: %s", treatmentReason), nil
	}

	return "", fmt.Errorf("invalid response format")
}
