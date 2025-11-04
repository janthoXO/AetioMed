package service

import (
	"case-generator/models"
	"case-generator/utils"
	"context"
	"encoding/json"
	"fmt"
	"strings"

	log "github.com/sirupsen/logrus"
	ilvimodels "gitlab.lrz.de/ILVI/ilvi/ilvi-api/model"
)

type OneshotService struct {
	llmService LLMService
}

func NewOneshotService() *OneshotService {
	return &OneshotService{
		llmService: GetLLMService(),
	}
}
func (s *OneshotService) createOneShotPrompt(diseaseName string, fieldsToGenerate byte, symptoms []models.Symptom, treatmentReason string, anamnesis []ilvimodels.Anamnesis, procedures []models.Procedure) string {
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
- Answer in German`,
		diseaseName,
		strings.Join(
			utils.MapSlice(
				models.BitmaskToFlagArr(fieldsToGenerate),
				func(f models.FieldFlag) string {
					return f.String()
				}),
			", "),
		utils.ContextLine(symptoms, treatmentReason, anamnesis, procedures),
		func() string {
			var fields []string
			if models.TreatmentReasonFlag.IsInBitMask(fieldsToGenerate) {
				fields = append(fields, models.TreatmentReasonExampleJSON)
			}

			if models.AnamnesisFlag.IsInBitMask(fieldsToGenerate) {
				fields = append(fields, fmt.Sprintf(`"anamnesis": %s`, models.AnamnesisExampleJSONArr))
			}
			return strings.Join(fields, ",")
		}(),
	)
}

func (s *OneshotService) GenerateOneShotCase(ctx context.Context, diseaseName string, fieldsToGenerate byte, symptoms []models.Symptom, treatmentReason string, anamnesis []ilvimodels.Anamnesis, procedures []models.Procedure) (string, []ilvimodels.Anamnesis, error) {
	// Check if service is available
	if !s.llmService.HealthCheck(ctx) {
		return treatmentReason, anamnesis, fmt.Errorf("LLM service is not available. Please ensure Ollama is running")
	}

	prompt := s.createOneShotPrompt(diseaseName, fieldsToGenerate, symptoms, treatmentReason, anamnesis, procedures)
	response, err := s.llmService.Generate(ctx, prompt)
	if err != nil {
		log.Errorf("Failed to generate one shot case: %v", err)
		return treatmentReason, anamnesis, fmt.Errorf("failed to generate one shot case: %w", err)
	}

	jsonObject, err := utils.ExtractJsonObject(response)
	if err != nil {
		return treatmentReason, anamnesis, fmt.Errorf("no json object found in response: %w", err)
	}

	if models.TreatmentReasonFlag.IsInBitMask(fieldsToGenerate) {
		treatmentReason = jsonObject["treatmentReason"].(string)
	}

	if models.AnamnesisFlag.IsInBitMask(fieldsToGenerate) {
		for _, item := range jsonObject["anamnesis"].([]any) {
			var a ilvimodels.Anamnesis 
			b, _ := json.Marshal(item)
			err := json.Unmarshal(b, &a)
			if err != nil {
				continue
			}
			anamnesis = append(anamnesis, a)
		}
	}

	return treatmentReason, anamnesis, nil

}
