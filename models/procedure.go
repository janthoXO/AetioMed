package models

type Procedure struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
}

// FromDict creates a Procedure from a map, similar to Python's from_dict method
func (p *Procedure) FromDict(data map[string]interface{}) error {
	// Set ID
	if id, ok := data["id"].(string); ok {
		p.ID = id
	}

	// Set name
	if name, ok := data["name"].(string); ok {
		p.Name = name
	}

	// Set description
	if description, ok := data["description"].(string); ok && description != "" {
		p.Description = description
	}

	return nil
}
