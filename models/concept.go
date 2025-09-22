package models

type Concept struct {
	UI                string `json:"ui"`
	Name              string `json:"name"`
	DateAdded         string `json:"dateAdded"`
	MajorRevisionDate string `json:"majorRevisionDate"`
	ClassType         string `json:"classType"`
	Suppressible      bool   `json:"suppressible"`
	Status            string `json:"status"`
	SemanticTypes     []struct {
		Name string `json:"name"`
		URI  string `json:"uri"`
	} `json:"semanticTypes"`
	Atoms                string `json:"atoms"`
	Definitions          string `json:"definitions"`
	Relations            string `json:"relations"`
	DefaultPreferredAtom string `json:"defaultPreferredAtom"`
	AtomCount            int    `json:"atomCount"`
	CVMemberCount        int    `json:"cvMemberCount"`
	AttributeCount       int    `json:"attributeCount"`
	RelationCount        int    `json:"relationCount"`

	RelationParent *Relation `json:"relationParent,omitempty"`
	AtomParent     *Atom     `json:"atomParent,omitempty"`
}
