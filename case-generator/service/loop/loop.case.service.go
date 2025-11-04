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
	treatmentReasonService *service.TreatmentReasonService
	consistencyService  *service.ConsistencyService
	oneshotService      *service.OneshotService
}

func NewLoopCaseService() *LoopCaseService {
	return &LoopCaseService{
		anamnesisService:    service.NewAnamnesisService(),
		treatmentReasonService: service.NewTreatmentReasonService(),
		consistencyService:  service.NewConsistencyService(),
		oneshotService:      service.NewOneshotService(),
	}
}

func (s *LoopCaseService) GenerateWholeCase(ctx context.Context, diseaseName string, bitMask byte, symptoms []models.Symptom, treatmentReason string, anamnesis []models.Anamnesis, procedures []models.Procedure) (string, []models.Anamnesis, error) {

	// generate everything one shot once
	treatmentReason, anamnesis, err := s.oneshotService.GenerateOneShotCase(ctx, diseaseName, bitMask, symptoms, treatmentReason, anamnesis, procedures)
	if err != nil {
		return treatmentReason, anamnesis, err
	}

	i := 0
	priorityQueue := s.createPriorityQueue(bitMask)
	inconsistencyPrompts := make(map[models.FieldFlag][]string)
	for i < ITERATIONS {
		// Check for inconsistencies
		inconsistencies, err := s.consistencyService.CheckConsistency(ctx, diseaseName, bitMask, symptoms, treatmentReason, anamnesis, procedures)
		if err != nil {
			return treatmentReason, anamnesis, err
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
				case models.TreatmentReasonFlag:
					treatmentReason, err = s.treatmentReasonService.GenerateTreatmentReason(ctx, diseaseName, symptoms, anamnesis, procedures, prompts...)
					if err != nil {
						return treatmentReason, anamnesis, err
					}
				case models.AnamnesisFlag:
					anamnesis, err = s.anamnesisService.GenerateAnamnesis(ctx, diseaseName, symptoms, treatmentReason, procedures, prompts...)
					if err != nil {
						return treatmentReason, anamnesis, err
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
	return treatmentReason, anamnesis, nil
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
