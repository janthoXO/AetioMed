package service

import (
	"case-generator/models"
	"case-generator/utils"
	"context"
	"fmt"
	"strings"

	log "github.com/sirupsen/logrus"
)

type ConsistencyService struct {
	llmService *LLMService
}

func NewConsistencyService() *ConsistencyService {
	return &ConsistencyService{
		llmService: GetLLMService(),
	}
}

func (s *ConsistencyService) createConsistencyPrompt(diseaseName string, symptoms []models.Symptom, patientPresentation models.PatientPresentation, anamnesis []models.Anamnesis, procedures []models.Procedure, additionalPrompt ...string) string {
	return fmt.Sprintf(`
	Review this clinical case for %s for consistency:

%s

Check for:
1. Medical accuracy
2. Consistency between symptoms, treatment reason, and anamnesis
3. Logical coherence

Return ONLY a JSON object:
{
  "Field": %s,
  "issue": string,
  "recommendation": string
}
`, diseaseName, utils.ContextLine(symptoms, patientPresentation, anamnesis, procedures), strings.Join(models.AllFlagNames(), "|"))
}

func (s *ConsistencyService) CheckConsistency(ctx context.Context, diseaseName string, symptoms []models.Symptom, patientPresentation models.PatientPresentation, anamnesis []models.Anamnesis, procedures []models.Procedure) (consistencies []models.Inconsistency, err error) {
	prompt := s.createConsistencyPrompt(diseaseName, symptoms, patientPresentation, anamnesis, procedures)
	log.Debugf("Consistency prompt: %s\n", prompt)

	response, err := s.llmService.Generate(ctx, prompt)
	if err != nil {
		log.Errorf("Failed to generate consistency check: %v", err)
		return nil, fmt.Errorf("failed to generate consistency check: %w", err)
	}

	consistencyArray, err := utils.ExtractJsonArray(response)
	if err != nil {
		return nil, fmt.Errorf("no consistency found in response: %w", err)
	}

	for _, item := range consistencyArray {
		var c models.Inconsistency
		c.FromDict(item)
		consistencies = append(consistencies, c)
	}

	return consistencies, nil
}
