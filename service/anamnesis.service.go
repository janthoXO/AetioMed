package service

import (
	"case-generator/models"
	"case-generator/utils"
	"context"
	"fmt"

	log "github.com/sirupsen/logrus"
)

type AnamnesisService struct {
	llmService *LLMService
}

func NewAnamnesisService() *AnamnesisService {
	return &AnamnesisService{
		llmService: GetLLMService(),
	}
}

func (s *AnamnesisService) createAnamnesisPrompt(diseaseName string, symptoms []models.Symptom, patientPresentation string) string {
	return fmt.Sprintf(`You are a medical expert AI. Given a disease name, symptoms and a patient presentation reason, provide an anamnesis.

Disease: %s

Symptoms: %v

Patient Presentation: %s

The anamnesis should contain the categories:
- Krankheitsverlauf
- Vorerkrankungen
- Medikamente
- Allergien
- Familienanamnese
- Kardiovaskuläre Risikofaktoren
- Sozial-/Berufsanamnese
Please respond with a JSON object containing the anamnesis.
 [
	// array of anamnesis categories
	{
		"category":      string // the category of the anamnesis question
		"answer":        string // the answer to the question
		"timeCost":      float64 // time needed to ask the question in minutes
	}, ...
]


Requirements:
- Be medically accurate
- Use standard medical terminology
- Only include the JSON response, no additional text
`, diseaseName, symptoms, patientPresentation)
}

func (s *AnamnesisService) GenerateAnamnesis(ctx context.Context, diseaseName string, symptoms []models.Symptom, patientPresentation models.PatientPresentation) (anamnesis []models.Anamnesis, err error) {
	// Check if service is available
	if !s.llmService.HealthCheck(ctx) {
		return nil, fmt.Errorf("LLM service is not available. Please ensure Ollama is running")
	}

	response, err := s.llmService.Generate(ctx, s.createAnamnesisPrompt(diseaseName, symptoms, patientPresentation.TreatmentReason))
	if err != nil {
		log.Errorf("Failed to generate anamnesis: %v", err)
		return nil, fmt.Errorf("failed to generate anamnesis: %w", err)
	}

	anamnesisArray, err := utils.ExtractJsonArray(response)
	if err != nil {
		return nil, fmt.Errorf("no anamnesis found in response: %w", err)
	}

	for _, item := range anamnesisArray {
		var a models.Anamnesis
		a.FromDict(item)
		anamnesis = append(anamnesis, a)
	}

	return anamnesis, nil
}
