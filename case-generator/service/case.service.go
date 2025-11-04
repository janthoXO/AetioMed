package service

import (
	"case-generator/models"
	"context"

	ilvimodels "gitlab.lrz.de/ILVI/ilvi/ilvi-api/model"
)

// CaseContext holds all the state for case generation
type CaseContext struct {
	DiseaseName     string
	Symptoms        []models.Symptom
	TreatmentReason string
	Anamnesis       []ilvimodels.Anamnesis
	Procedures      []models.Procedure
}

type CaseService interface {
	GenerateWholeCase(ctx context.Context, diseaseName string, bitMask byte, symptoms []models.Symptom, treatmentReason string, anamnesis []ilvimodels.Anamnesis, procedures []models.Procedure) (string, []ilvimodels.Anamnesis, error)
}
