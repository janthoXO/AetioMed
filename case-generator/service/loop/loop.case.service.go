package loop

import (
	"case-generator/models"
	"case-generator/service"
	"case-generator/utils"
	"context"
	"fmt"
	"strings"

	log "github.com/sirupsen/logrus"
)

const ITERATIONS = 3

type LoopCaseService struct {
	anamnesisService    *service.AnamnesisService
	presentationService *service.PatientPresentationService
	consistencyService  *service.ConsistencyService
	llmService          service.LLMService
}

func NewLoopCaseService() *LoopCaseService {
	return &LoopCaseService{
		anamnesisService:    service.NewAnamnesisService(),
		presentationService: service.NewPatientPresentationService(),
		consistencyService:  service.NewConsistencyService(),
		llmService:          service.GetLLMService(),
	}
}

func (s *LoopCaseService) createOneShotPrompt(diseaseName string, bitMask byte, symptoms []models.Symptom, patientPresentation models.PatientPresentation, anamnesis []models.Anamnesis, procedures []models.Procedure) string {
	return fmt.Sprintf(`You are a medical expert AI. Generate a complete medical case for a patient with %s. Do not directly mention the disease name in the case. The case should be for student learning and contain %s. 

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
				s += fmt.Sprintf(`"patient_presentation": %s,`, models.PatientPresentationExampleJSON)
			}

			if models.AnamnesisFlag.IsInBitMask(bitMask) {
				s += fmt.Sprintf(`"anamnesis": %s,`, models.AnamnesisExampleJSON)
			}
			return s
		}(),
	)
}

func (s *LoopCaseService) GenerateOneShotCase(ctx context.Context, diseaseName string, bitMask byte, symptoms []models.Symptom, patientPresentation models.PatientPresentation, anamnesis []models.Anamnesis, procedures []models.Procedure) (models.PatientPresentation, []models.Anamnesis, error) {
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
		patientPresentation.FromDict(jsonObject["patient_presentation"].(map[string]any))
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

func (s *LoopCaseService) GenerateWholeCase(ctx context.Context, diseaseName string, bitMask byte, symptoms []models.Symptom, patientPresentation models.PatientPresentation, anamnesis []models.Anamnesis, procedures []models.Procedure) (models.PatientPresentation, []models.Anamnesis, error) {

	// generate everything one shot once
	patientPresentation, anamnesis, err := s.GenerateOneShotCase(ctx, diseaseName, bitMask, symptoms, patientPresentation, anamnesis, procedures)
	if err != nil {
		return patientPresentation, anamnesis, err
	}

	i := 0
	priorityQueue := s.createPriorityQueue(bitMask)
	inconsistencyPrompts := make(map[models.FieldFlag][]string)
	for i < ITERATIONS {
		// Check for inconsistencies
		inconsistencies, err := s.consistencyService.CheckConsistency(ctx, diseaseName, bitMask, symptoms, patientPresentation, anamnesis, procedures)
		if err != nil {
			return patientPresentation, anamnesis, err
		}
		// If no inconsistencies break
		if len(inconsistencies) == 0 {
			log.Debug("No inconsistencies found")
			break
		}

		log.Debugf("Inconsistencies: %+v\n", inconsistencies)
		for _, inconsistency := range inconsistencies {
			inconsistencyPrompts[inconsistency.Field] = append(inconsistencyPrompts[inconsistency.Field], inconsistency.PromptLine())
		}

		// look up priority and regenerate highest priority with inconsistencies
		for _, field := range priorityQueue {
			if prompts, ok := inconsistencyPrompts[field]; ok {
				log.Debugf("Regenerating field: %s\n", field)
				switch field {
				case models.PatientPresentationFlag:
					patientPresentation, err = s.presentationService.GeneratePatientPresentation(ctx, diseaseName, symptoms, anamnesis, procedures, prompts...)
					if err != nil {
						return patientPresentation, anamnesis, err
					}
				case models.AnamnesisFlag:
					anamnesis, err = s.anamnesisService.GenerateAnamnesis(ctx, diseaseName, symptoms, patientPresentation, procedures, prompts...)
					if err != nil {
						return patientPresentation, anamnesis, err
					}
				}
				// inconsistency prompts will be regenerated in next iteration
				break
			}
		}

		// assign newly generated field

		// rotate priority queue
		priorityQueue = s.rotatePriorityQueue(priorityQueue)

		// increase iteration
		i++
	}

	// Return the final state
	return patientPresentation, anamnesis, nil
}

func (s *LoopCaseService) createPriorityQueue(bitMask byte) []models.FieldFlag {
	var priorityQueue []models.FieldFlag
	for _, flag := range models.AllFlags() {
		if flag.IsInBitMask(bitMask) {
			priorityQueue = append(priorityQueue, flag)
		}
	}
	return priorityQueue
}

func (s *LoopCaseService) rotatePriorityQueue(priorityQueue []models.FieldFlag) []models.FieldFlag {
	return append(priorityQueue[1:], priorityQueue[0])
}
