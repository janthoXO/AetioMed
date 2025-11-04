package utils

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"

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

func ExtractArrayStrings(input string) ([]string, error) {
	re := regexp.MustCompile(`(?s)\[.*\]`)
	match := re.FindString(input)

	if match == "" {
		return nil, fmt.Errorf("no JSON array found in input")
	}
	return MapSlice[string](strings.Split(match, ","), strings.TrimSpace), nil
}

// UnwrapJSONArr extracts a JSON array from a wrapped JSON structure like {"arr": [ ... ]}
func UnwrapJSONArr(s string) string {
	re := regexp.MustCompile(`(?s)\{\s*\"arr\":\s*(\[.*\])\s*\}`)
	matches := re.FindStringSubmatch(s)

	if len(matches) < 2 {
		return ""
	}

	return matches[1]
}
