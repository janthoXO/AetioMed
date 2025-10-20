// {
//   "isConsistent": true/false,
//   "issues": ["list of issues found, empty if consistent"],
//   "recommendations": ["what should be regenerated if inconsistent"]
// }

package models

import (
	"fmt"
	"strings"
)

type Inconsistency struct {
	Field          FieldFlag
	Issue          string
	Recommendation string
}

func (c *Inconsistency) FromDict(data map[string]any) {
	if fieldStr, ok := data["field"].(string); ok {
		c.Field, _ = StringToFieldFlag(fieldStr)
	}

	if issueStr, ok := data["issue"].(string); ok {
		c.Issue = issueStr
	}

	if recStr, ok := data["recommendation"].(string); ok {
		c.Recommendation = recStr
	}
}

func (c *Inconsistency) PromptLine() string {
	return fmt.Sprintf("Inconsistency: %s\nRecommendation: %s\n", c.Issue, c.Recommendation)
}

func ConsistencyExampleJSON(fields []string) string {
	return fmt.Sprintf(`{
		"field": "%s",
		"issue": string,
		"recommendation": string
		}`, strings.Join(fields, "|"),
	)
}

func ConsistencyStructuredOutput(fields []string) string {
	return fmt.Sprintf(`{
"type": "object",
"properties": {
	"field": {
		"type": "%s"
	},
	"issue": {
		"type": "string"
	},
	"recommendation": {
		"type": "string"
	}
}
}`,
		strings.Join(fields, "|"),
	)
}

func ConsistencyStructuredOutputArray(fields []string) string {
	return fmt.Sprintf("{\"type\":\"array\",\"items\":%s}", ConsistencyStructuredOutput(fields))
}
