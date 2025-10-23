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
		"field": "%s", // enum
		"issue": string,
		"recommendation": string
		}`, strings.Join(fields, "\" | \""),
	)
}

func ConsistencyExampleJSONArr(fields []string) string {
	return fmt.Sprintf("[%s]", ConsistencyExampleJSON(fields))
}
