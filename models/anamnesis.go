package models

type Anamnesis struct {
	Category      string `json:"category"`
	Answer        string `json:"answer"`
	TimeCost      float64 `json:"timeCost"`
}

func (a *Anamnesis) FromDict(dict map[string]interface{}) {
	if val, ok := dict["category"].(string); ok {
		a.Category = val
	}
	if val, ok := dict["answer"].(string); ok {
		a.Answer = val
	}
	if val, ok := dict["timeCost"].(float64); ok {
		a.TimeCost = val
	}
}