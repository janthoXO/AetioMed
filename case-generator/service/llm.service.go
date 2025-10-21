package service

import (
	"context"
	"time"
)

const HEALTH_CHECK_INTERVAL = time.Duration(120 * time.Second)

type HealthCheck struct {
	lastChecked time.Time
	healthy     bool
}

type LLMService interface {
	Generate(ctx context.Context, prompt string) (string, error)
	HealthCheck(ctx context.Context) bool
}

func GetLLMService() LLMService {
	return GetHttpLLMService()
}
