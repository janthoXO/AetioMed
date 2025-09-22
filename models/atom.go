package models

type Atom struct {
	ClassType        string `json:"classType"`
	UI               string `json:"ui"`
	SourceDescriptor string `json:"sourceDescriptor"`
	SourceConcept    string `json:"sourceConcept"`
	Concept          string `json:"concept"`
	Suppressible     string `json:"suppressible"`
	Obsolete         string `json:"obsolete"`
	RootSource       string `json:"rootSource"`
	TermType         string `json:"termType"`
	Code             string `json:"code"`
	Language         string `json:"language"`
	Name             string `json:"name"`
	Ancestors        string `json:"ancestors"`
	Descendants      string `json:"descendants"`
	Attributes       string `json:"attributes"`
	Relations        string `json:"relations"`
	Children         string `json:"children"`
	Parents          string `json:"parents"`

	RelationParent    *Relation    `json:"relationParent,omitempty"`
	AtomClusterParent *AtomCluster `json:"atomClusterParent,omitempty"`
}
