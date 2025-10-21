package service

import (
	"case-generator/models"
	"context"
)

// CaseContext holds all the state for case generation
type CaseContext struct {
	DiseaseName         string
	Symptoms     []models.Symptom
	PatientPresentation models.PatientPresentation
	Anamnesis           []models.Anamnesis
	Procedures          []models.Procedure
}

type CaseService interface {
	GenerateWholeCase(ctx context.Context, diseaseName string, bitMask byte, symptoms []models.Symptom, patientPresentation models.PatientPresentation, anamnesis []models.Anamnesis, procedures []models.Procedure) (models.PatientPresentation, []models.Anamnesis, error)
}
