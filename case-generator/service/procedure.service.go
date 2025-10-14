package service

import (
	"case-generator/models"
	"context"
)

type ProcedureService struct {
}

func NewProcedureService() *ProcedureService {
	return &ProcedureService{}
}

func (s *ProcedureService) MatchProcedures(ctx context.Context, diseaseProcedures []models.Procedure, symptomProcedures []models.Procedure) (result []models.Procedure, err error) {
	// Procedures which are in both lists are mandatory
	// Procedures which are only in the symptom list are supporting but not mandatory

	// create map to faster lookup
	diseaseProcedureMap := make(map[string]models.Procedure)
	for _, diseaseProcedure := range diseaseProcedures {
		diseaseProcedureMap[diseaseProcedure.ID] = diseaseProcedure
	}

	for _, symptomProcedure := range symptomProcedures {
		if _, exists := diseaseProcedureMap[symptomProcedure.ID]; exists {
			symptomProcedure.Type = models.Mandatory
			result = append(result, symptomProcedure)
		} else {
			symptomProcedure.Type = models.Supporting
			result = append(result, symptomProcedure)
		}
	}

	return result, nil
}
