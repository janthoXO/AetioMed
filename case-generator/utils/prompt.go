package utils

import (
	"case-generator/models"
	"fmt"

	ilvimodels "gitlab.lrz.de/ILVI/ilvi/ilvi-api/model"
)

func ContextLine(symptoms []models.Symptom, treatmentReason string, anamnesis []ilvimodels.Anamnesis, procedures []models.Procedure) string {
	s := ""
	if symptoms != nil && len(symptoms) > 0 {
		s = fmt.Sprintf("%s symptoms: %+v\n", s, symptoms)
	}

	if treatmentReason != "" {
		s = fmt.Sprintf("%streatment reason: %s\n", s, treatmentReason)
	}

	if anamnesis != nil && len(anamnesis) > 0 {
		s = fmt.Sprintf("%sanamnesis: %+v\n", s, anamnesis)
	}

	// TODO only add procedures names
	if procedures != nil && len(procedures) > 0 {
		s = fmt.Sprintf("%sprocedures: %+v\n", s, procedures)
	}

	if s != "" {
		return fmt.Sprintf("Context:\n%s", s)
	}

	return ""
}
