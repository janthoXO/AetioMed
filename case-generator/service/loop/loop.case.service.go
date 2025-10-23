package loop

import (
	"case-generator/models"
	"case-generator/service"
	"context"

	log "github.com/sirupsen/logrus"
)

const ITERATIONS = 6

type LoopCaseService struct {
	anamnesisService    *service.AnamnesisService
	presentationService *service.PatientPresentationService
	consistencyService  *service.ConsistencyService
	oneshotService      *service.OneshotService
}

func NewLoopCaseService() *LoopCaseService {
	return &LoopCaseService{
		anamnesisService:    service.NewAnamnesisService(),
		presentationService: service.NewPatientPresentationService(),
		consistencyService:  service.NewConsistencyService(),
		oneshotService:      service.NewOneshotService(),
	}
}

func (s *LoopCaseService) GenerateWholeCase(ctx context.Context, diseaseName string, bitMask byte, symptoms []models.Symptom, patientPresentation models.PatientPresentation, anamnesis []models.Anamnesis, procedures []models.Procedure) (models.PatientPresentation, []models.Anamnesis, error) {

	// generate everything one shot once
	patientPresentation, anamnesis, err := s.oneshotService.GenerateOneShotCase(ctx, diseaseName, bitMask, symptoms, patientPresentation, anamnesis, procedures)
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
		inconsistencyPrompts = make(map[models.FieldFlag][]string)
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

	log.Debugf("Needed %d iterations", i)

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
