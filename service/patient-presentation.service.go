package service

import (
	"case-generator/models"
	"context"
	"fmt"

	log "github.com/sirupsen/logrus"
)

type PatientPresentationService struct {
	llmService *LLMService
}

func NewPatientPresentationService() *PatientPresentationService {
	return &PatientPresentationService{
		llmService: GetLLMService(),
	}
}

func (s *PatientPresentationService) createPatientPresentationPrompt(diseaseName string, symptoms []models.Symptom) string {
	return fmt.Sprintf(`You are a medical expert AI. Given a disease name and a set of symptoms, provide an patient presentation picking a subset of the symptoms.

Disease: %s

Symptoms: %v

Please respond with a JSON object containing the patient presentation and the picked symptoms.
{
    "presentation": {
		"treatmentReason": "string", // A brief reason why the patient seeks medical attention
	},
	"symptoms": [ 
		// A list of the symptoms ids
	]
}

Requirements:
- Be medically accurate
- The treatment reason should be concise and relevant to the disease
- Pick symptoms that are commonly associated with the disease
- Ensure the JSON is properly formatted
- Only include the JSON response, no additional text
`, diseaseName, symptoms)
}

func (s *PatientPresentationService) GeneratePatientPresentation(ctx context.Context, diseaseName string, symptoms []models.Symptom) (presentation models.PatientPresentation, err error) {
	// Check if service is available
	if !s.llmService.HealthCheck(ctx) {
		return presentation, fmt.Errorf("LLM service is not available. Please ensure Ollama is running")
	}

	symptomData, err := s.llmService.GenerateJSON(ctx, s.createPatientPresentationPrompt(diseaseName, symptoms))
	if err != nil {
		log.Errorf("Failed to generate patient presentation: %v", err)
		return presentation, fmt.Errorf("failed to generate patient presentation: %w", err)
	}

	presentation.FromDict(symptomData["presentation"].(map[string]any))
	if presentation.TreatmentReason == "" {
		return presentation, fmt.Errorf("no patient presentation found in response")
	}

	symptomIds, ok := symptomData["symptoms"].([]any)
	if !ok {
		return presentation, fmt.Errorf("no symptoms found in response")
	}

	// Filter the symptoms to only include the picked ones
	symptomMap := make(map[string]models.Symptom)
	for _, symptom := range symptoms {
		symptomMap[symptom.ID] = symptom
	}

	for _, id := range symptomIds {
		if symptom, exists := symptomMap[id.(string)]; exists {
			presentation.Symptoms = append(presentation.Symptoms, symptom)
		}
	}

	return presentation, nil
}
