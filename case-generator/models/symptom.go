package models

import (
	"encoding/json"
	"strings"
)

type SeverityLevel string

const (
	SeverityMild     SeverityLevel = "mild"
	SeverityModerate SeverityLevel = "moderate"
	SeveritySevere   SeverityLevel = "severe"
)

type FrequencyLevel string

const (
	FrequencyRare       FrequencyLevel = "rare"
	FrequencyUncommon   FrequencyLevel = "uncommon"
	FrequencyCommon     FrequencyLevel = "common"
	FrequencyVeryCommon FrequencyLevel = "very_common"
)

type Symptom struct {
	ID          string         `json:"id"`
	Name        string         `json:"name"`
	MedicalName string         `json:"medical_name"`
	Description string         `json:"description,omitempty"`
	Severity    *SeverityLevel `json:"severity,omitempty"`
	Frequency   FrequencyLevel `json:"frequency"`
}

// FromDict creates a Symptom from a map, similar to Python's from_dict method
func (s *Symptom) FromDict(data map[string]interface{}) error {
	// Set name
	if name, ok := data["name"].(string); ok {
		s.Name = name
	}

	// Set medical_name
	if medicalName, ok := data["medical_name"].(string); ok {
		s.MedicalName = medicalName
	}

	// Set description
	if description, ok := data["description"].(string); ok && description != "" {
		s.Description = description
	}

	// Set severity with validation
	if severityStr, ok := data["severity"].(string); ok && severityStr != "" {
		severity := SeverityLevel(strings.ToLower(severityStr))
		switch severity {
		case SeverityMild, SeverityModerate, SeveritySevere:
			s.Severity = &severity
		}
	}

	// Set frequency with validation and default
	s.Frequency = FrequencyCommon // default
	if frequencyStr, ok := data["frequency"].(string); ok && frequencyStr != "" {
		frequency := FrequencyLevel(strings.ToLower(frequencyStr))
		switch frequency {
		case FrequencyRare, FrequencyUncommon, FrequencyCommon, FrequencyVeryCommon:
			s.Frequency = frequency
		}
	}

	return nil
}

// Custom JSON marshaling to handle frequency conversion
func (f FrequencyLevel) MarshalJSON() ([]byte, error) {
	return json.Marshal(string(f))
}

func (f *FrequencyLevel) UnmarshalJSON(data []byte) error {
	var s string
	if err := json.Unmarshal(data, &s); err != nil {
		return err
	}
	*f = FrequencyLevel(strings.ToLower(s))
	return nil
}

// Custom JSON marshaling to handle severity conversion
func (s SeverityLevel) MarshalJSON() ([]byte, error) {
	return json.Marshal(string(s))
}

func (s *SeverityLevel) UnmarshalJSON(data []byte) error {
	var str string
	if err := json.Unmarshal(data, &str); err != nil {
		return err
	}
	*s = SeverityLevel(strings.ToLower(str))
	return nil
}
