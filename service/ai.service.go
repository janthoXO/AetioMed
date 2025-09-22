package service

import (
	"context"
	"fmt"

	log "github.com/sirupsen/logrus"
)

type AiService struct {
	llmService *LLMService
}

func NewAiService(llmService *LLMService) *AiService {
	return &AiService{
		llmService: llmService,
	}
}

func (s *AiService) ServiceName() string {
	return "AI Symptom Service"
}

func (s *AiService) createSymptomPrompt(diseaseName string) string {
	return fmt.Sprintf(`You are a medical expert AI. Given a disease name, provide a comprehensive list of symptoms commonly associated with this disease.

Disease: %s

Please respond with a JSON object containing an array of symptoms. Each symptom should have the following structure:
{
    "name": "symptom name",
    "medical_name": "medical term for the symptom",
    "description": "brief description of the symptom",
    "severity": "mild|moderate|severe",
    "frequency": "rare|uncommon|common|very_common"
}

Requirements:
- Include characteristic symptoms but also rare ones
- Be medically accurate
- Use standard medical terminology
- Focus on symptoms that are diagnostically relevant
- Only include the JSON response, no additional text

Response format:
{
    "symptoms": [
        // array of symptom objects
    ]
}`, diseaseName)
}

func (s *AiService) FetchSymptoms(ctx context.Context, diseaseName string) ([]any, error) {
	// Check if service is available
	if !s.llmService.HealthCheck(ctx) {
		return nil, fmt.Errorf("LLM service is not available. Please ensure Ollama is running")
	}

	symptomData, err := s.llmService.GenerateJSON(ctx, s.createSymptomPrompt(diseaseName))
	if err != nil {
		log.Errorf("Failed to generate symptoms: %v", err)
		return nil, fmt.Errorf("failed to generate symptoms: %w", err)
	}

	// Extract symptoms array from response
	symptomsArray, ok := symptomData["symptoms"].([]interface{})
	if !ok {
		return nil, fmt.Errorf("no symptoms found in response")
	}

	return symptomsArray, nil
}
