package models

type PatientPresentation struct {
	TreatmentReason string    `json:"treatmentReason"`
	Symptoms        []Symptom `json:"symptoms"`
}

func (pp *PatientPresentation) FromDict(data map[string]any) {
	pp.TreatmentReason = data["treatmentReason"].(string)

	symptoms, ok := data["symptoms"].([]any)
	if !ok {
		return
	}

	for _, s := range symptoms {
		symptomMap, ok := s.(map[string]any)
		if !ok {
			continue
		}
		var symptom Symptom
		if err := symptom.FromDict(symptomMap); err != nil {
			continue
		}
		pp.Symptoms = append(pp.Symptoms, symptom)
	}
}

const PatientPresentationExampleJSON = `{"treatmentReason": "the patient's complaint in their own words"}`
