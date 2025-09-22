package service

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"disease-middleware/models"
	"disease-middleware/utils"

	log "github.com/sirupsen/logrus"
)

type UmlsService struct{}

func (s *UmlsService) ServiceName() string {
	return "UMLS API Service"
}

func (s *UmlsService) FetchSymptoms(ctx context.Context, icd string) ([]any, error) {
	// Query Disease by name
	disease, err := queryDiseaseByName(ctx, icd)
	if err != nil {
		log.Errorf("Failed to find disease for %s: %v", icd, err)
		return nil, fmt.Errorf("Failed to find disease for %s", icd)
	}

	log.Infof("Disease %s %s\n", disease["ui"].(string), disease["name"].(string))

	errChannel := make(chan error, 1)
	go func() {
		for {
			err, ok := <-errChannel
			if !ok {
				return
			}
			log.Error(err)
		}
	}()

	// Query Symptoms by Disease
	relationChannel := utils.NewUniqueChannel[*models.Relation](100)
	go func() {
		queryRelations(ctx, disease["ui"].(string), relationChannel, errChannel)
	}()

	atomClusterChannel := utils.NewUniqueChannel[*models.AtomCluster](100)
	atomChannel := utils.NewUniqueChannel[*models.Atom](100)
	conceptChannel := utils.NewUniqueChannel[*models.Concept](100)

	// query relatedIds which can be either AtomClusters, Atoms or Concepts
	go func() {
		for {
			select {
			case <-ctx.Done():
				atomClusterChannel.Close()
				return
			case relation, ok := <-relationChannel.Chan():
				if !ok {
					// close AtomClusterChannel to signal no more clusters, there might be more atoms tho coming from handling the clusters
					atomClusterChannel.Close()
					return
				}
				queryRelatedIdFromRelation(ctx, relation, atomClusterChannel, atomChannel, conceptChannel, errChannel)
			}
		}
	}()

	// query atoms from AtomClusters
	go func() {
		for {
			select {
			case <-ctx.Done():
				atomChannel.Close()
				return
			case atomCluster, ok := <-atomClusterChannel.Chan():
				if !ok {
					// close AtomChannel to signal no more atoms, there might still be more concepts coming from handling the atoms
					atomChannel.Close()
					return
				}
				queryAtomsFromAtomCluster(ctx, atomCluster, atomChannel, errChannel)
			}
		}
	}()

	// query concepts from Atoms
	go func() {
		for {
			select {
			case <-ctx.Done():
				conceptChannel.Close()
				return
			case atom, ok := <-atomChannel.Chan():
				if !ok {
					conceptChannel.Close()
					return
				}
				queryConceptsFromAtom(ctx, atom, conceptChannel, errChannel)
			}
		}
	}()

	symptoms := make([]any, 0)
	done := make(chan struct{})
	go func() {
		for {
			select {
			case <-ctx.Done():
				close(done)
				return
			case concept, ok := <-conceptChannel.Chan():
				if !ok {
					// conceptChannel closed
					close(done)
					return
				}

				// check if concept is a symptom
				if concept.SemanticTypes[0].Name != "Sign or Symptom" {
					continue
				}
				symptoms = append(symptoms, concept)
			}
		}
	}()

	<-done

	// Check if the request was canceled
	if ctx.Err() != nil {
		return nil, fmt.Errorf("Request canceled")
	}

	log.Info("Done")

	return symptoms, nil
}

// Returns the UI of the disease
func queryDiseaseByName(ctx context.Context, icd string) (map[string]any, error) {
	// Send http request to umls
	url := fmt.Sprintf("%s/search/current?apiKey=%s&string=%s&sabs=ICD10", utils.Cfg.UmlsApi.Url, utils.Cfg.UmlsApi.ApiKey, url.QueryEscape(icd))

	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return nil, err
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("Error querying disease by name: %s", body)
	}

	var body struct {
		PageSize   int `json:"pageSize"`
		PageNumber int `json:"pageNumber"`
		Result     struct {
			Results []map[string]any `json:"results"`
		}
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return nil, err
	}

	if body.Result.Results == nil {
		return nil, fmt.Errorf("Failed to find disease for %s", icd)
	}

	return body.Result.Results[0], nil
}

func queryRelations(ctx context.Context, diseaseCui string, relationChannel *utils.UniqueChannel[*models.Relation], errChannel chan<- error) {
	url := fmt.Sprintf("%s/content/current/CUI/%s/relations?apiKey=%s&pageSize=10000", utils.Cfg.UmlsApi.Url, diseaseCui, utils.Cfg.UmlsApi.ApiKey)

	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		errChannel <- fmt.Errorf("Error creating request for relations: %w", err)
		return
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		errChannel <- fmt.Errorf("Error querying relations by disease: %w", err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		errChannel <- fmt.Errorf("Error querying relations by disease %s: %s", resp.Status, body)
		return
	}

	var body struct {
		PageSize   int               `json:"pageSize"`
		PageNumber int               `json:"pageNumber"`
		PageCount  int               `json:"pageCount"`
		Result     []models.Relation `json:"result"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		errChannel <- fmt.Errorf("Error decoding response: %w", err)
		return
	}

	for _, relation := range body.Result {
		relationChannel.Pub(&relation, relation.Ui)
	}
	relationChannel.Close()
}

func queryRelatedIdFromRelation(ctx context.Context, relation *models.Relation, atomClusterChannel *utils.UniqueChannel[*models.AtomCluster], atomChannel *utils.UniqueChannel[*models.Atom], conceptChannel *utils.UniqueChannel[*models.Concept], errChannel chan<- error) {
	switch relation.ClassType {
	case "AtomClusterRelation":
		var atomCluster models.AtomCluster
		err := utils.CacheInstance.Get(relation.RelatedId, &atomCluster)
		if err == nil {
			// if found in cache, no need to fetch
			atomClusterChannel.Pub(&atomCluster, atomCluster.UI)
			return
		}

	case "AtomRelation":
		var atom models.Atom
		err := utils.CacheInstance.Get(relation.RelatedId, &atom)
		if err == nil {
			// if found in cache, no need to fetch
			atomChannel.Pub(&atom, atom.UI)
			return
		}

	case "ConceptRelation":
		var concept models.Concept
		err := utils.CacheInstance.Get(relation.RelatedId, &concept)
		if err == nil {
			// if found in cache, no need to fetch
			conceptChannel.Pub(&concept, concept.UI)
			return
		}
	default:
		return
	}

	url, err := url.Parse(relation.RelatedId)
	if err != nil {
		errChannel <- fmt.Errorf("Error parsing relatedId url: %w", err)
		return
	}
	q := url.Query()
	q.Add("apiKey", utils.Cfg.UmlsApi.ApiKey)
	url.RawQuery = q.Encode()

	req, err := http.NewRequestWithContext(ctx, "GET", url.String(), nil)
	if err != nil {
		errChannel <- fmt.Errorf("Error creating request for relatedId: %w", err)
		return
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		errChannel <- fmt.Errorf("Error querying relatedId: %w", err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		errChannel <- fmt.Errorf("Error querying relatedId %s: %s", resp.Status, body)
		return
	}

	var body struct {
		PageSize   int             `json:"pageSize"`
		PageNumber int             `json:"pageNumber"`
		PageCount  int             `json:"pageCount"`
		Result     json.RawMessage `json:"result"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		errChannel <- fmt.Errorf("Error decoding response relatedId: %w", err)
		return
	}

	switch relation.ClassType {
	case "AtomClusterRelation":
		var atomCluster models.AtomCluster
		if err := json.Unmarshal(body.Result, &atomCluster); err != nil {
			errChannel <- fmt.Errorf("Error unmarshalling atom cluster: %w", err)
			return
		}

		atomCluster.RelationParent = relation
		new := atomClusterChannel.Pub(&atomCluster, atomCluster.UI)
		if !new {
			return
		}
		utils.CacheInstance.Set(relation.RelatedId, atomCluster)

	case "AtomRelation":
		var atom models.Atom
		if err := json.Unmarshal(body.Result, &atom); err != nil {
			errChannel <- fmt.Errorf("Error unmarshalling atom: %w", err)
			return
		}

		atom.RelationParent = relation
		new := atomChannel.Pub(&atom, atom.UI)
		if !new {
			return
		}
		utils.CacheInstance.Set(relation.RelatedId, atom)

	case "ConceptRelation":
		var concept models.Concept
		if err := json.Unmarshal(body.Result, &concept); err != nil {
			errChannel <- fmt.Errorf("Error unmarshalling concept: %w", err)
			return
		}

		concept.RelationParent = relation
		new := conceptChannel.Pub(&concept, concept.UI)
		if !new {
			return
		}
		utils.CacheInstance.Set(relation.RelatedId, concept)

	default:
		errChannel <- fmt.Errorf("Unknown relation class type: %s", relation.ClassType)
	}
}

func queryAtomsFromAtomCluster(ctx context.Context, atomCluster *models.AtomCluster, atomChannel *utils.UniqueChannel[*models.Atom], errChannel chan<- error) {
	var atom models.Atom
	err := utils.CacheInstance.Get(atomCluster.DefaultPreferredAtom, &atom)
	if err == nil {
		// if found in cache, no need to fetch
		atomChannel.Pub(&atom, atom.UI)
		return
	}

	url, err := url.Parse(atomCluster.DefaultPreferredAtom)
	if err != nil {
		errChannel <- fmt.Errorf("Error parsing atoms url from atom cluster: %w", err)
		return
	}
	q := url.Query()
	q.Add("apiKey", utils.Cfg.UmlsApi.ApiKey)
	// q.Add("pageSize", "1000")
	url.RawQuery = q.Encode()

	req, err := http.NewRequestWithContext(ctx, "GET", url.String(), nil)
	if err != nil {
		errChannel <- fmt.Errorf("Error creating request for atoms from atom cluster: %w", err)
		return
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		errChannel <- fmt.Errorf("Error querying atoms from atom cluster: %w", err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		errChannel <- fmt.Errorf("Error querying atoms from atom cluster %s: %s\n", resp.Status, body)
		// fmt.Printf("AtomCluster: %+v\nUrl %s\n", atomCluster, url.String())
		return
	}

	var body struct {
		PageSize   int         `json:"pageSize"`
		PageNumber int         `json:"pageNumber"`
		PageCount  int         `json:"pageCount"`
		Result     models.Atom `json:"result"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		errChannel <- fmt.Errorf("Error decoding response atom from atom cluster: %w", err)
		return
	}

	body.Result.AtomClusterParent = atomCluster
	new := atomChannel.Pub(&body.Result, body.Result.UI)
	if !new {
		return
	}

	utils.CacheInstance.Set(atomCluster.DefaultPreferredAtom, body.Result)
}

func queryConceptsFromAtom(ctx context.Context, atom *models.Atom, conceptChannel *utils.UniqueChannel[*models.Concept], errChannel chan<- error) {
	var concept models.Concept
	err := utils.CacheInstance.Get(atom.Concept, &concept)
	if err == nil {
		// if found in cache, no need to fetch
		conceptChannel.Pub(&concept, concept.UI)
		return
	}

	url, err := url.Parse(atom.Concept)
	if err != nil {
		errChannel <- fmt.Errorf("Error parsing concept url from atom: %w", err)
		return
	}
	q := url.Query()
	q.Add("apiKey", utils.Cfg.UmlsApi.ApiKey)
	url.RawQuery = q.Encode()

	req, err := http.NewRequestWithContext(ctx, "GET", url.String(), nil)
	if err != nil {
		errChannel <- fmt.Errorf("Error creating request for concept from atom: %w", err)
		return
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		errChannel <- fmt.Errorf("Error querying atoms from atom cluster: %w", err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		errChannel <- fmt.Errorf("Error querying atoms from atom cluster %s: %s", resp.Status, body)
		return
	}

	var body struct {
		PageSize   int            `json:"pageSize"`
		PageNumber int            `json:"pageNumber"`
		PageCount  int            `json:"pageCount"`
		Result     models.Concept `json:"result"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		errChannel <- fmt.Errorf("Error decoding response atom from atom cluster: %w", err)
		return
	}

	body.Result.AtomParent = atom
	new := conceptChannel.Pub(&body.Result, body.Result.UI)
	if !new {
		return
	}

	utils.CacheInstance.Set(atom.Concept, body.Result)
}
