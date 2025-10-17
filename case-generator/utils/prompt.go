package utils

import (
	"case-generator/models"
	"fmt"
)

func ContextLine(symptoms []models.Symptom, presentation models.PatientPresentation, anamnesis []models.Anamnesis, procedures []models.Procedure) string {
	s := ""
	if symptoms != nil {
		s = fmt.Sprintf("%s symptoms: %+v\n", s, symptoms)
	}

	if presentation.TreatmentReason != "" {
		s = fmt.Sprintf("%streatment reason: %s\n", s, presentation.TreatmentReason)
	}

	if anamnesis != nil {
		s = fmt.Sprintf("%sanamnesis: %+v\n", s, anamnesis)
	}

	// TODO only add procedures names
	if procedures != nil {
		s = fmt.Sprintf("%sprocedures: %+v\n", s, procedures)
	}

	if s != "" {
		return fmt.Sprintf("Context:\n%s", s)
	}

	return ""
}
