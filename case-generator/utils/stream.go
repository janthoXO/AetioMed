package utils

import "iter"

func MapIter[I, O any](input iter.Seq[I], f func(I) O) iter.Seq[O] {
	return func(yield func(O) bool) {
		for a := range input {
			if !yield(f(a)) {
				return
			}
		}
	}
}

func MapSlice[I, O any](input []I, f func(I) O) []O {
	output := make([]O, len(input))
	for i, v := range input {
		output[i] = f(v)
	}
	return output
}
