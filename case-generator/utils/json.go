package utils

import (
	"encoding/json"
	"fmt"
	"regexp"

	log "github.com/sirupsen/logrus"
)

func ExtractJsonObject(input string) (map[string]any, error) {
	re := regexp.MustCompile(`(?s)\{.*\}`)
	match := re.FindString(input)

	if match == "" {
		return nil, fmt.Errorf("no JSON object found in input")
	}
	jsonStr := match

	var jsonData map[string]any
	if err := json.Unmarshal([]byte(jsonStr), &jsonData); err != nil {
		log.Errorf("Failed to parse LLM JSON response: %v", err)
		return nil, fmt.Errorf("failed to parse LLM JSON response: %w", err)
	}

	return jsonData, nil
}

func ExtractJsonArray(input string) ([]map[string]any, error) {
	re := regexp.MustCompile(`(?s)\[.*\]`)
	match := re.FindString(input)

	if match == "" {
		return nil, fmt.Errorf("no JSON array found in input")
	}
	jsonStr := match

	var jsonData []map[string]any
	if err := json.Unmarshal([]byte(jsonStr), &jsonData); err != nil {
		log.Errorf("Failed to parse LLM JSON response: %v", err)
		return nil, fmt.Errorf("failed to parse LLM JSON response: %w", err)
	}

	return jsonData, nil
}
