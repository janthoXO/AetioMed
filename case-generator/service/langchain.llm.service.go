package service

import (
	"case-generator/utils"
	"context"
	"fmt"
	"time"

	"github.com/tmc/langchaingo/llms"
	"github.com/tmc/langchaingo/llms/ollama"

	log "github.com/sirupsen/logrus"
)

type LangchainLLMService struct {
	llm         llms.Model
	healthCheck HealthCheck
}

var langchainLLMService = LangchainLLMService{
	llm: nil,
	healthCheck: HealthCheck{
		lastChecked: time.Time{}, // init with zero time
		healthy:     false,
	},
}

func GetLangchainLLMService() *LangchainLLMService {
	return &langchainLLMService
}

func (s *LangchainLLMService) Generate(ctx context.Context, prompt string) (string, error) {
	log.Debugf("Using Langchain Ollama at: %s", utils.Cfg.OllamaApi.Url)
	log.Debugf("Using model: %s", utils.Cfg.OllamaApi.Model)

	if s.llm == nil {
		var err error
		s.llm, err = ollama.New(
			ollama.WithServerURL(utils.Cfg.OllamaApi.Url),
			ollama.WithModel(utils.Cfg.OllamaApi.Model),
		)
		if err != nil {
			return "", fmt.Errorf("failed to create LLM: %w", err)
		}
	}

	response, err := llms.GenerateFromSinglePrompt(ctx, s.llm, prompt)
	log.Debugf("Raw response: %s\n", response)
	return response, err
}

func (s *LangchainLLMService) HealthCheck(ctx context.Context) bool {
	if s.healthCheck.healthy && s.healthCheck.lastChecked.Add(HEALTH_CHECK_INTERVAL).After(time.Now()) {
		return true
	}

	if s.llm == nil {
		var err error
		s.llm, err = ollama.New(
			ollama.WithServerURL(utils.Cfg.OllamaApi.Url),
			ollama.WithModel(utils.Cfg.OllamaApi.Model),
		)
		if err != nil {
			return false
		}
	}

	s.healthCheck.healthy = true
	s.healthCheck.lastChecked = time.Now()
	return s.healthCheck.healthy
}
