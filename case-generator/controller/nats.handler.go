package controller

type NatsHandler interface {
	RegisterHandler() error
}