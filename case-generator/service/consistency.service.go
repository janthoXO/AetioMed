package service

import (
	"case-generator/models"
	"case-generator/utils"
	"context"
	"fmt"

	log "github.com/sirupsen/logrus"
)

type ConsistencyService struct {
	llmService LLMService
}

func NewConsistencyService() *ConsistencyService {
	return &ConsistencyService{
		llmService: GetLLMService(),
	}
}

func (s *ConsistencyService) createConsistencyPrompt(diseaseName string, fieldsToCheck []string, symptoms []models.Symptom, patientPresentation models.PatientPresentation, anamnesis []models.Anamnesis, procedures []models.Procedure) string {
	return fmt.Sprintf(`
	Review this clinical case of a patient with %s for consistency. It should be for student learning and the disease should not be directly spoiled. Do not check for consistency with the disease but rather between the fields provided.

%s

Check for:
1. Medical accuracy
2. Consistency between symptoms, treatment reason, and anamnesis
3. Logical coherence

Return ONLY a JSON object: {
	"arr": %s
}

Requirements:
- Be medically accurate
- Only include the JSON response, no additional text
`, diseaseName, utils.ContextLine(symptoms, patientPresentation, anamnesis, procedures),
		models.ConsistencyExampleJSONArr(fieldsToCheck))
}

func (s *ConsistencyService) CheckConsistency(ctx context.Context, diseaseName string, fieldsToCheck byte, symptoms []models.Symptom, patientPresentation models.PatientPresentation, anamnesis []models.Anamnesis, procedures []models.Procedure) (consistencies []models.Inconsistency, err error) {
	flagStrings := utils.MapSlice(models.BitmaskToFlagArr(fieldsToCheck), func(f models.FieldFlag) string {
		return f.String()
	})

	prompt := s.createConsistencyPrompt(diseaseName, flagStrings, symptoms, patientPresentation, anamnesis, procedures)
	response, err := s.llmService.Generate(ctx, prompt)
	if err != nil {
		log.Errorf("Failed to generate consistency check: %v", err)
		return nil, fmt.Errorf("failed to generate consistency check: %w", err)
	}

	inconsistenciesArray, err := utils.ExtractJsonArray(utils.UnwrapJSONArr(response))
	if err != nil {
		return nil, fmt.Errorf("no consistency found in response: %w", err)
	}

	for _, item := range inconsistenciesArray {
		var c models.Inconsistency
		c.FromDict(item)
		consistencies = append(consistencies, c)
	}

	return consistencies, nil
}
