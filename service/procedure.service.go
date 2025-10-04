package service

import (
	"case-generator/models"
	"context"
	"fmt"
)

type ProcedureService struct {
	llmService *LLMService
}

func NewProcedureService() *ProcedureService {
	return &ProcedureService{
		llmService: GetLLMService(),
	}
}

func (s *ProcedureService) GetProcedure(ctx context.Context, diseaseName string, symptoms []models.Symptom) ([]models.Procedure, error) {
	return nil, fmt.Errorf("not implemented")
}
