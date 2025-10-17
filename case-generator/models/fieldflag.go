package models

import (
	"maps"
	"slices"
)

type FieldFlag byte

const (
	PatientPresentationFlag FieldFlag = 1 << iota
	AnamnesisFlag
)

var flagNames = map[FieldFlag]string{
	PatientPresentationFlag: "treatment reason",
	AnamnesisFlag:           "anamnesis",
}

func (flag FieldFlag) String() string {
	return flagNames[flag]
}

func AllFlagNames() []string {
	return slices.Collect(maps.Values(flagNames))
}
