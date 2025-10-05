package models

type Procedure struct {
	Name string `json:"name"`
	ID string `json:"id"`
	Domain string `json:"domain"`
	Category string `json:"category"`
	Title string `json:"title"`
	Text string `json:"text"`
	Files []string `json:"files"`
	TimeCost int `json:"timeCost"`
	MoneyCost int `json:"moneyCost"`
	IsDefault bool `json:"isDefault"`
}
