package service

import (
	"bytes"
	"case-generator/utils"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	log "github.com/sirupsen/logrus"
)

type OllamaRequest struct {
	Model   string                 `json:"model"`
	Prompt  string                 `json:"prompt"`
	Stream  bool                   `json:"stream"`
	Format  string                 `json:"format"`
	Options map[string]interface{} `json:"options"`
}

type OllamaResponse struct {
	Response string `json:"response"`
}

type HttpLLMService struct {
	client      *http.Client
	healthCheck HealthCheck
}

var httpLLMService = HttpLLMService{
	client: &http.Client{},
	healthCheck: HealthCheck{
		lastChecked: time.Time{}, // init with zero time
		healthy:     false,
	},
}

func GetHttpLLMService() *HttpLLMService {
	return &httpLLMService
}

func (s *HttpLLMService) Generate(ctx context.Context, prompt string, structuredOutput string) (string, error) {
	if structuredOutput == "" {
		structuredOutput = "json"
	}
	// TODO remove
	structuredOutput = "json"

	payload := OllamaRequest{
		Model:  utils.Cfg.OllamaApi.Model,
		Prompt: prompt,
		Stream: false,
		Format: structuredOutput,
	}

	jsonData, err := json.Marshal(payload)
	if err != nil {
		log.Errorf("Error marshaling request: %v", err)
		return "", fmt.Errorf("failed to marshal request: %w", err)
	}

	log.Debugf("Using Http Ollama: %s", jsonData)

	url := fmt.Sprintf("%s/api/generate", utils.Cfg.OllamaApi.Url)
	req, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewBuffer(jsonData))
	if err != nil {
		log.Errorf("Error creating request: %v", err)
		return "", fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")

	resp, err := s.client.Do(req)
	if err != nil {
		log.Errorf("Connection error to Ollama: %v", err)
		return "", fmt.Errorf("cannot connect to Ollama service. Please ensure Ollama is running: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		log.Errorf("HTTP error when calling Ollama: status %d", resp.StatusCode)
		return "", fmt.Errorf("failed to connect to Ollama service: status %d", resp.StatusCode)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		log.Errorf("Error reading response body: %v", err)
		return "", fmt.Errorf("failed to read response: %w", err)
	}

	var result OllamaResponse
	if err := json.Unmarshal(body, &result); err != nil {
		log.Errorf("Error unmarshaling response: %v", err)
		return "", fmt.Errorf("failed to parse response: %w", err)
	}

	log.Debugf("LLM raw response: %s", result.Response)
	return result.Response, nil
}

func (s *HttpLLMService) HealthCheck(ctx context.Context) bool {
	if s.healthCheck.healthy && s.healthCheck.lastChecked.Add(HEALTH_CHECK_INTERVAL).After(time.Now()) {
		return true
	}

	url := fmt.Sprintf("%s/api/tags", utils.Cfg.OllamaApi.Url)
	log.Debugf("Performing health check on Ollama at: %s", url)
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return false
	}

	resp, err := s.client.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()

	s.healthCheck.healthy = resp.StatusCode == http.StatusOK
	s.healthCheck.lastChecked = time.Now()
	return s.healthCheck.healthy
}
