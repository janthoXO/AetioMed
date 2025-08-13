package utils

import (
	"sync"
)

type UniqueChannel[T any] struct {
	channel chan T
	ids     map[string]bool
	mutex   sync.RWMutex
}

func NewUniqueChannel[T any](bufferSize int) *UniqueChannel[T] {
	return &UniqueChannel[T]{
		channel: make(chan T, bufferSize),
		ids:     make(map[string]bool),
	}
}

func (uc *UniqueChannel[T]) Pub(obj T, id string) bool {
	uc.mutex.Lock()
	defer uc.mutex.Unlock()

	if uc.ids[id] {
		return false // Already exists, don't publish
	}

	uc.ids[id] = true
	uc.channel <- obj
	return true
}

func (uc *UniqueChannel[T]) Chan() <-chan T {
	return uc.channel
}

func (uc *UniqueChannel[T]) Close() {
	uc.mutex.Lock()
	defer uc.mutex.Unlock()

	close(uc.channel)
}
