package service

import (
	"context"
	"disease-middleware/utils"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type MeshService struct{}

func (s *MeshService) FetchSymptoms(ctx context.Context, diseaseName string) ([]any, error) {
	// The SPARQL query template.
	queryTemplate := `
PREFIX mesh: <http://id.nlm.nih.gov/mesh/>
PREFIX meshv: <http://id.nlm.nih.gov/mesh/vocab#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>

SELECT DISTINCT ?symptomLabel
WHERE {
	# Find the disease by label
    ?diseaseDescriptor rdf:type meshv:TopicalDescriptor .
	?diseaseDescriptor rdfs:label ?diseaseLabel .
	FILTER(REGEX(LCASE(?diseaseLabel), LCASE("{{diseaseName}}")))

	# Filter inactive descriptors
	# ?diseaseDescriptor meshv:active ?diseaseDescriptorActive .
	# FILTER(?diseaseDescriptorActive = true)

	# Get tree number and filter for Diseases "C"
	?diseaseDescriptor meshv:treeNumber ?diseaseTreeNumber .
	FILTER(REGEX(?diseaseTreeNumber, "C"))

	# Get disease concept
	{
		?diseaseDescriptor meshv:concept ?diseaseConcept .
	} 
	UNION 
	{
		?diseaseDescriptor meshv:preferredConcept ?diseaseConcept .
	}

	# Get symptom concept
	?diseaseConcept meshv:relatedConcept ?symptomConcept .
	?symptomConcept rdfs:label ?symptomLabel .
	?symptomDescriptor meshv:concept ?symptomConcept .
    # Get tree number and filter for "C23"
	?symptomDescriptor meshv:treeNumber ?symptomTreeNumber .
	FILTER(REGEX(?symptomTreeNumber, "C23"))
}
LIMIT 100
`

	// Replace the placeholder with the actual disease name.
	query := strings.Replace(queryTemplate, "{{diseaseName}}", diseaseName, 1)

	// URL-encode the query to send it in the request.
	encodedQuery := url.QueryEscape(query)

	// Construct the full URL with the query parameters.
	reqURL := fmt.Sprintf("%s?query=%s&format=json", utils.Cfg.MeshApi.Url, encodedQuery)

	// Set up the HTTP client with a timeout.
	client := http.Client{Timeout: 10 * time.Second}
	req, err := http.NewRequestWithContext(context.Background(), "GET", reqURL, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	// Execute the request.
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to execute SPARQL query: %w", err)
	}
	defer resp.Body.Close()

	bodyBytes, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("SPARQL query failed with status code %d: %s", resp.StatusCode, string(bodyBytes))
	}

	fmt.Printf("Response: %s\n", string(bodyBytes))

	// TODO: Parse the JSON response to extract the list of symptom names.
	// The response will be in a JSON format similar to:
	// { "head": { ... }, "results": { "bindings": [ { "symptomName": { "value": "Fever" } }, ... ] } }
	// This part of the code needs to be implemented to iterate through the bindings and extract symptomName.

	return []any{
		string(bodyBytes),
	}, nil // Placeholder
}
