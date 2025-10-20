package service

import (
	"case-generator/models"
	"case-generator/utils"
	"context"
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

func (s *AnamnesisService) createAnamnesisPrompt(diseaseName string, symptoms []models.Symptom, patientPresentation models.PatientPresentation, procedures []models.Procedure, additionalPrompt ...string) string {
	return fmt.Sprintf(`You are a medical expert AI. Generate realistic anamnesis (medical history) for a patient with %s.

%s

Return ONLY a JSON object:{
	"arr": %s
}

Requirements:
- Be medically accurate
- Use standard medical terminology
- Only include the JSON response, no additional text

%s
`, diseaseName,
		utils.ContextLine(symptoms, patientPresentation, nil, procedures),
		models.AnamnesisExampleJSONArr,
		strings.Join(additionalPrompt, "\n"))
}

func (s *AnamnesisService) GenerateAnamnesis(ctx context.Context, diseaseName string, symptoms []models.Symptom, patientPresentation models.PatientPresentation, procedures []models.Procedure, additionalPrompt ...string) (anamnesis []models.Anamnesis, err error) {
	// Check if service is available
	if !s.llmService.HealthCheck(ctx) {
		return nil, fmt.Errorf("LLM service is not available. Please ensure Ollama is running")
	}

	prompt := s.createAnamnesisPrompt(diseaseName, symptoms, patientPresentation, procedures, additionalPrompt...)
	response, err := s.llmService.Generate(ctx, prompt, utils.WrapArrStructuredOutput(models.AnamnesisStructuredOutputArray))
	if err != nil {
		log.Errorf("Failed to generate anamnesis: %v", err)
		return nil, fmt.Errorf("failed to generate anamnesis: %w", err)
	}

	anamnesisArr, err := utils.ExtractJsonArray(utils.UnwrapStructuredOutputArrResponse(response))
	if err != nil {
		return nil, fmt.Errorf("no anamnesis found in response: %w", err)
	}

	for _, item := range anamnesisArr {
		var a models.Anamnesis
		a.FromDict(item)
		anamnesis = append(anamnesis, a)
	}

	return anamnesis, nil
}
