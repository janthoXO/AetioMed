package service

import (
	"case-generator/models"
	"case-generator/utils"
	"context"
	"encoding/json"
	"fmt"
	"strings"


	log "github.com/sirupsen/logrus"
)

type AnamnesisService struct {
	llmService LLMService
}

func NewAnamnesisService() *AnamnesisService {
	return &AnamnesisService{
		llmService: GetLLMService(),
	}
}

func (s *AnamnesisService) createAnamnesisPrompt(diseaseName string, symptoms []models.Symptom, treatmentReason string, procedures []models.Procedure, additionalPrompt ...string) string {
	return fmt.Sprintf(`You are a medical expert AI. Generate realistic anamnesis (medical history) for a patient with %s.

%s

Return ONLY a JSON object:{
	"arr": %s
}

Requirements:
- Be medically accurate
- Use standard medical terminology
- Only include the JSON response, no additional text
- Answer in German

%s`, diseaseName,
		utils.ContextLine(symptoms, treatmentReason, nil, procedures),
		models.AnamnesisExampleJSONArr,
		strings.Join(additionalPrompt, "\n"))
}

func (s *AnamnesisService) GenerateAnamnesis(ctx context.Context, diseaseName string, symptoms []models.Symptom, treatmentReason string, procedures []models.Procedure, additionalPrompt ...string) (anamnesis []models.Anamnesis, err error) {
	// Check if service is available
	if !s.llmService.HealthCheck(ctx) {
		return nil, fmt.Errorf("LLM service is not available. Please ensure Ollama is running")
	}

	prompt := s.createAnamnesisPrompt(diseaseName, symptoms, treatmentReason, procedures, additionalPrompt...)
	response, err := s.llmService.Generate(ctx, prompt)
	if err != nil {
		log.Errorf("Failed to generate anamnesis: %v", err)
		return nil, fmt.Errorf("failed to generate anamnesis: %w", err)
	}

	anamnesisStringArr, err := utils.ExtractArrayStrings(utils.UnwrapJSONArr(response))
	if err != nil {
		return nil, fmt.Errorf("no anamnesis found in response: %w", err)
	}

	for _, item := range anamnesisStringArr {
		var a models.Anamnesis
		err := json.Unmarshal([]byte(item), &a)
		if err != nil {
			continue
		}
		anamnesis = append(anamnesis, a)
	}

	return anamnesis, nil
}
