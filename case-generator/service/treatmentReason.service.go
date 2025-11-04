package service

import (
	"case-generator/models"
	"case-generator/utils"
	"context"
	"fmt"
	"strings"

	log "github.com/sirupsen/logrus"
)

type TreatmentReasonService struct {
	llmService LLMService
}

func NewTreatmentReasonService() *TreatmentReasonService {
	return &TreatmentReasonService{
		llmService: GetLLMService(),
	}
}

func (s *TreatmentReasonService) createTreatmentReasonPrompt(diseaseName string, symptoms []models.Symptom, anamnesis []models.Anamnesis, procedures []models.Procedure, additionalPrompt ...string) string {
	return fmt.Sprintf(`You are a medical expert AI. Generate a realistic chief complaint (treatment reason) for a patient with %s.

%s

Return ONLY a JSON object: {
%s
}

Requirements:
- Be medically accurate
- The treatment reason should be concise and relevant to the disease
- Ensure the JSON is properly formatted
- Only include the JSON response, no additional text
- Answer in German

%s`,
		diseaseName,
		utils.ContextLine(symptoms, "", anamnesis, procedures),
		models.TreatmentReasonExampleJSON,
		strings.Join(additionalPrompt, "\n"))
}

func (s *TreatmentReasonService) GenerateTreatmentReason(ctx context.Context, diseaseName string, symptoms []models.Symptom, anamnesis []models.Anamnesis, procedures []models.Procedure, additionalPrompt ...string) (treatmentReason string, err error) {
	// Check if service is available
	if !s.llmService.HealthCheck(ctx) {
		return treatmentReason, fmt.Errorf("LLM service is not available. Please ensure Ollama is running")
	}

	prompt := s.createTreatmentReasonPrompt(diseaseName, symptoms, anamnesis, procedures, additionalPrompt...)
	response, err := s.llmService.Generate(ctx, prompt)
	if err != nil {
		log.Errorf("Failed to generate treatment reason: %v", err)
		return treatmentReason, fmt.Errorf("failed to generate treatment reason: %w", err)
	}
	jsonObject, err := utils.ExtractJsonObject(response)
	if err != nil {
		log.Errorf("Failed to parse treatment reason: %v", err)
		return treatmentReason, fmt.Errorf("failed to parse treatment reason: %w", err)
	}

	treatmentReason = jsonObject["treatmentReason"].(string)
	if treatmentReason == "" {
		return treatmentReason, fmt.Errorf("no treatment reason found in response")
	}

	return treatmentReason, nil
}
