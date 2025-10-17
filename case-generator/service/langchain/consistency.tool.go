package langchain

import (
	"case-generator/service"
	"context"
	"fmt"

	log "github.com/sirupsen/logrus"
)

// CheckConsistencyTool validates consistency across all fields
type CheckConsistencyTool struct {
	ctx        *service.CaseContext
	llmService *service.LLMService
}

func NewCheckConsistencyTool(ctx *service.CaseContext, llmService *service.LLMService) *CheckConsistencyTool {
	return &CheckConsistencyTool{ctx: ctx, llmService: llmService}
}

func (t *CheckConsistencyTool) Name() string {
	return "CheckConsistency"
}

func (t *CheckConsistencyTool) Description() string {
	return "Checks consistency across all generated fields (symptoms, treatment reason, anamnesis). Input should be empty or 'check'. Returns a detailed report of any inconsistencies found."
}

func (t *CheckConsistencyTool) Call(ctx context.Context, input string) (string, error) {
	log.Debugf("CheckConsistencyTool called with %+v\n %s", t.ctx, input)

	prompt := fmt.Sprintf(`Review this clinical case for %s for consistency:

Context symptoms: %+v
Treatment reason: %s
Anamnesis: %+v

Check for:
1. Medical accuracy
2. Consistency between symptoms, treatment reason, and anamnesis
3. Logical coherence

Return ONLY a JSON object:
{
  "isConsistent": true/false,
  "issues": ["list of issues found, empty if consistent"],
  "recommendations": ["what should be regenerated if inconsistent"]
}`, t.ctx.DiseaseName, t.ctx.Symptoms, t.ctx.PatientPresentation.TreatmentReason, t.ctx.Anamnesis)

	response, err := t.llmService.Generate(ctx, prompt)
	if err != nil {
		return "", fmt.Errorf("failed to check consistency: %w", err)
	}

	return string(response), nil
}
