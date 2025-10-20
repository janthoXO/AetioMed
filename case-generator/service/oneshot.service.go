package service

import (
	"case-generator/models"
	"case-generator/utils"
	"context"
	"fmt"
	"strings"

	log "github.com/sirupsen/logrus"
)

type OneshotService struct {
	llmService LLMService
}

func NewOneshotService() *OneshotService {
	return &OneshotService{
		llmService: GetLLMService(),
	}
}
func (s *OneshotService) createOneShotPrompt(diseaseName string, bitMask byte, symptoms []models.Symptom, patientPresentation models.PatientPresentation, anamnesis []models.Anamnesis, procedures []models.Procedure) string {
	return fmt.Sprintf(`You are a medical expert AI. Generate a medical case for a patient with %s. Do not directly mention the disease name in the case. The case should be for student learning and contain %s. 

%s

Return ONLY a JSON object:
{
	%s
}

Requirements:
- Be medically accurate
- Use standard medical terminology
- Only include the JSON response, no additional text
- Guarantee consistency between all fields
	`,
		diseaseName,
		strings.Join(
			utils.MapSlice(
				models.BitmaskToFlagArr(bitMask),
				func(f models.FieldFlag) string {
					return f.String()
				}),
			","),
		utils.ContextLine(symptoms, patientPresentation, anamnesis, procedures),
		func() string {
			s := ""
			if models.PatientPresentationFlag.IsInBitMask(bitMask) {
				s += fmt.Sprintf(`"patientPresentation": %s,`, models.PatientPresentationExampleJSON)
			}

			if models.AnamnesisFlag.IsInBitMask(bitMask) {
				s += fmt.Sprintf(`"anamnesis": %s,`, models.AnamnesisExampleJSON)
			}
			return s
		}(),
	)
}

func (s *OneshotService) GenerateOneShotCase(ctx context.Context, diseaseName string, bitMask byte, symptoms []models.Symptom, patientPresentation models.PatientPresentation, anamnesis []models.Anamnesis, procedures []models.Procedure) (models.PatientPresentation, []models.Anamnesis, error) {
	// Check if service is available
	if !s.llmService.HealthCheck(ctx) {
		return patientPresentation, anamnesis, fmt.Errorf("LLM service is not available. Please ensure Ollama is running")
	}

	prompt := s.createOneShotPrompt(diseaseName, bitMask, symptoms, patientPresentation, anamnesis, procedures)
	log.Debugf("One shot Prompt: %s\n", prompt)
	response, err := s.llmService.Generate(ctx, prompt)
	if err != nil {
		log.Errorf("Failed to generate one shot case: %v", err)
		return patientPresentation, anamnesis, fmt.Errorf("failed to generate one shot case: %w", err)
	}

	jsonObject, err := utils.ExtractJsonObject(response)
	if err != nil {
		return patientPresentation, anamnesis, fmt.Errorf("no json object found in response: %w", err)
	}

	if models.PatientPresentationFlag.IsInBitMask(bitMask) {
		patientPresentation.FromDict(jsonObject["patientPresentation"].(map[string]any))
	}

	if models.AnamnesisFlag.IsInBitMask(bitMask) {
		for _, item := range jsonObject["anamnesis"].([]any) {
			var a models.Anamnesis
			a.FromDict(item.(map[string]any))
			anamnesis = append(anamnesis, a)
		}
	}

	return patientPresentation, anamnesis, nil

}