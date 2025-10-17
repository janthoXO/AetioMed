package service

import (
	"case-generator/models"
	"case-generator/utils"
	"context"
	"fmt"
	"strings"

	log "github.com/sirupsen/logrus"
)

type PatientPresentationService struct {
	llmService LLMService
}

func NewPatientPresentationService() *PatientPresentationService {
	return &PatientPresentationService{
		llmService: GetLLMService(),
	}
}

func (s *PatientPresentationService) createPatientPresentationPrompt(diseaseName string, symptoms []models.Symptom, anamnesis []models.Anamnesis, procedures []models.Procedure, additionalPrompt ...string) string {
	return fmt.Sprintf(`You are a medical expert AI. Generate a realistic chief complaint (treatment reason) for a patient with %s.

%s

Return ONLY a JSON object: 
{"treatmentReason": "the patient's complaint in their own words"}

Requirements:
- Be medically accurate
- The treatment reason should be concise and relevant to the disease
- Ensure the JSON is properly formatted
- Only include the JSON response, no additional text

%s
`, diseaseName, utils.ContextLine(symptoms, models.PatientPresentation{}, anamnesis, procedures), strings.Join(additionalPrompt, "\n"))
}

func (s *PatientPresentationService) GeneratePatientPresentation(ctx context.Context, diseaseName string, symptoms []models.Symptom, anamnesis []models.Anamnesis, procedures []models.Procedure, additionalPrompt ...string) (presentation models.PatientPresentation, err error) {
	// Check if service is available
	if !s.llmService.HealthCheck(ctx) {
		return presentation, fmt.Errorf("LLM service is not available. Please ensure Ollama is running")
	}

	prompt := s.createPatientPresentationPrompt(diseaseName, symptoms, anamnesis, procedures, additionalPrompt...)
	log.Debugf("Presentation Prompt: %s\n", prompt)
	response, err := s.llmService.Generate(ctx, prompt)
	if err != nil {
		log.Errorf("Failed to generate patient presentation: %v", err)
		return presentation, fmt.Errorf("failed to generate patient presentation: %w", err)
	}
	jsonObject, err := utils.ExtractJsonObject(response)
	if err != nil {
		log.Errorf("Failed to parse patient presentation: %v", err)
		return presentation, fmt.Errorf("failed to parse patient presentation: %w", err)
	}

	presentation.FromDict(jsonObject)
	if presentation.TreatmentReason == "" {
		return presentation, fmt.Errorf("no patient presentation found in response")
	}

	return presentation, nil
}
