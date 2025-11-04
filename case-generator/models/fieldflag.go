package models

import (
	"maps"
	"slices"
)

type FieldFlag byte

const (
	TreatmentReasonFlag FieldFlag = 1 << iota
	AnamnesisFlag
)

var flagNames = map[FieldFlag]string{
	TreatmentReasonFlag: "treatmentReason",
	AnamnesisFlag:       "anamnesis",
}

func (flag FieldFlag) String() string {
	return flagNames[flag]
}

func (flag FieldFlag) IsInBitMask(bitMask byte) bool {
	return bitMask&byte(flag) != 0
}

func BitmaskToFlagArr(bitMask byte) []FieldFlag {
	var flags []FieldFlag
	for flag := range maps.Keys(flagNames) {
		if flag.IsInBitMask(bitMask) {
			flags = append(flags, flag)
		}
	}
	return flags
}

var nameToFlag map[string]FieldFlag

func StringToFieldFlag(name string) (FieldFlag, bool) {
	if nameToFlag == nil {
		// init map once
		nameToFlag = make(map[string]FieldFlag)
		for flag, flagName := range flagNames {
			nameToFlag[flagName] = flag
		}
	}

	flag, ok := nameToFlag[name]
	return flag, ok
}

func AllFlags() []FieldFlag {
	return slices.Collect(maps.Keys(flagNames))
}
