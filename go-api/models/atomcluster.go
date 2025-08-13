package models

type AtomCluster struct {
	ClassType            string `json:"classType"`
	UI                   string `json:"ui"`
	Suppressible         bool   `json:"suppressible"`
	Obsolete             bool   `json:"obsolete"`
	RootSource           string `json:"rootSource"`
	AtomCount            int    `json:"atomCount"`
	CVMemberCount        int    `json:"cVMemberCount"`
	Attributes           string `json:"attributes"`
	Atoms                string `json:"atoms"`
	Ancestors            string `json:"ancestors"`
	Parents              string `json:"parents"`
	Children             string `json:"children"`
	Descendants          string `json:"descendants"`
	Relations            string `json:"relations"`
	Definitions          string `json:"definitions"`
	Concepts             string `json:"concepts"`
	DefaultPreferredAtom string `json:"defaultPreferredAtom"`
	Name                 string `json:"name"`

	RelationParent *Relation `json:"relationParent,omitempty"`
}
