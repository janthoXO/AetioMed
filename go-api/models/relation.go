package models

type Relation struct {
      Ui string `json:"ui"`
      Suppressible bool `json:"suppressible"`
      SourceUi string `json:"sourceUi"`
      Obsolete bool `json:"obsolete"`
      SourceOriginated bool `json:"sourceOriginated"`
      RootSource string `json:"rootSource"`
      GroupId string `json:"groupId"`
      AttributeCount int `json:"attributeCount"`
      ClassType string `json:"classType"`
      RelatedFromId string `json:"relatedFromId"`
      RelatedFromIdName string `json:"relatedFromIdName"`
      RelationLabel string `json:"relationLabel"`
      AdditionalRelationLabel string `json:"additionalRelationLabel"`
      RelatedId string `json:"relatedId"`
      RelatedIdName string `json:"relatedIdName"`
}