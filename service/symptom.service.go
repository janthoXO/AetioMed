package service

import "context"

type SymptomService interface {
	ServiceName() string
	FetchSymptoms(ctx context.Context, icd string) ([]any, error)
}