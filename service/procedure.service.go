package service

import (
	"context"
	"disease-middleware/models"
)

type ProcedureService interface {
	ServiceName() string
	FetchProceduresFromSymptoms(ctx context.Context, symptomIds []string) ([]models.Procedure, error)
	FetchProceduresFromDisease(ctx context.Context, icd string) ([]models.Procedure, error)
}