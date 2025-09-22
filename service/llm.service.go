package service

import (
	"bytes"
	"context"
	"disease-middleware/utils"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"

	log "github.com/sirupsen/logrus"
)

type OllamaRequest struct {
	Model   string                 `json:"model"`
	Prompt  string                 `json:"prompt"`
	Stream  bool                   `json:"stream"`
	Options map[string]interface{} `json:"options"`
}

type OllamaResponse struct {
	Response string `json:"response"`
}

type LLMService struct {
	client *http.Client
}

func NewLLMService() *LLMService {
	client := &http.Client{	}

	return &LLMService{
		client: client,
	}
}

func (s *LLMService) Generate(ctx context.Context, prompt string) (string, error) {
	log.Info("Requesting generation")
	log.Infof("Using Ollama at: %s", utils.Cfg.OllamaApi.Url)
	log.Infof("Using model: %s", utils.Cfg.OllamaApi.Model)

	payload := OllamaRequest{
		Model:  utils.Cfg.OllamaApi.Model,
		Prompt: prompt,
		Stream: false,
	}

	jsonData, err := json.Marshal(payload)
	if err != nil {
		log.Errorf("Error marshaling request: %v", err)
		return "", fmt.Errorf("failed to marshal request: %w", err)
	}

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

func (s *LLMService) GenerateJSON(ctx context.Context, prompt string) (map[string]any, error) {
	llmResponse, err := s.Generate(ctx, prompt)
	if err != nil {
		return nil, err
	}

    // Try to extract JSON from the response using regex (from first "{" to last "}")
    re := regexp.MustCompile(`(?s)\{.*\}`)
    match := re.FindString(llmResponse)

    var jsonStr string
    if match != "" {
        jsonStr = match
    } else {
        // Fallback: try to parse the entire response as JSON
        jsonStr = llmResponse
    }

	var jsonData map[string]any
	if err := json.Unmarshal([]byte(jsonStr), &jsonData); err != nil {
		log.Errorf("Failed to parse LLM JSON response: %v", err)
		return nil, fmt.Errorf("failed to parse LLM JSON response: %w", err)
	}

	return jsonData, nil
}

func (s *LLMService) HealthCheck(ctx context.Context) bool {
	url := fmt.Sprintf("%s/api/tags", utils.Cfg.OllamaApi.Url)
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return false
	}

	resp, err := s.client.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()

	return resp.StatusCode == http.StatusOK
}
