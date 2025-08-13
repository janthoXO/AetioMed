package service

import "context"

type SymptomService interface {
	FetchSymptoms(ctx context.Context, icd string) ([]any, error)
}