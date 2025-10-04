package service

import (
	"context"
	"disease-middleware/models"
)

type SymptomService interface {
	ServiceName() string
	FetchSymptoms(ctx context.Context, icd string) ([]models.Symptom, error)
}