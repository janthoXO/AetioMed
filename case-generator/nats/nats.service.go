package nats

import (
	"case-generator/utils"
	"fmt"

	"github.com/nats-io/nats.go"
	log "github.com/sirupsen/logrus"
)

type NatsService struct {
	conn *nats.Conn
	js   nats.JetStreamContext
}

var NatsServiceInstance *NatsService

func NewNatsService() (*NatsService, error) {
	opts := []nats.Option{
		nats.UserInfo(utils.Cfg.Nats.User, utils.Cfg.Nats.Password),
	}

	nc, err := nats.Connect(utils.Cfg.Nats.Url, opts...)
	if err != nil {
		return nil, fmt.Errorf("failed to connect to NATS: %w", err)
	}

	js, err := nc.JetStream()
	if err != nil {
		nc.Close()
		return nil, fmt.Errorf("failed to create JetStream context: %w", err)
	}

	service := &NatsService{
		conn: nc,
		js:   js,
	}

	log.Info("NATS service initialized successfully")
	return service, nil
}

func (s *NatsService) InitializeStream(streamName string, opts ...nats.JSOpt) error {
	// Create request stream
	_, err := s.js.AddStream(&nats.StreamConfig{
		Name:      streamName,
		Subjects:  []string{streamName + ".>"},
		Retention: nats.WorkQueuePolicy, // one-consumer-only
		Storage:   nats.FileStorage,
	}, opts...)
	if err != nil && err != nats.ErrStreamNameAlreadyInUse {
		return fmt.Errorf("failed to create %s stream: %w", streamName, err)
	}

	log.Info("NATS streams initialized: %s", streamName)
	return nil
}

// PublishMessage publishes a message to NATS
func (s *NatsService) PublishMessage(subject string, data []byte, opts ...nats.PubOpt) (err error) {
	// TODO check if stream exists, otherwise init

	_, err = s.js.Publish(subject, data, opts...)
	if err != nil {
		return fmt.Errorf("failed to publish request to %s: %w", subject, err)
	}

	log.Debugf("Published request to %s", subject)
	return nil
}

// SubscribeToRequests subscribes to request messages and processes them with the provided handler
func (s *NatsService) SubscribeToSubject(subject string, handler func(msg *nats.Msg), opts ...nats.SubOpt) error {
	_, err := s.js.Subscribe(subject, func(msg *nats.Msg) {
		log.Debug("Received message on %s", subject)
		handler(msg)
		msg.Ack()
	}, opts...)
	if err != nil {
		return fmt.Errorf("failed to subscribe to %s: %w", subject, err)
	}
	log.Infof("Subscribed to %s", subject)

	return nil
}

// Close closes the NATS connection
func (s *NatsService) Close() {
	if s.conn != nil {
		s.conn.Close()
		log.Info("NATS connection closed")
	}
}
