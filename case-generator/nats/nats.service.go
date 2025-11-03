package nats

import (
	"case-generator/utils"
	"fmt"
	"time"

	"github.com/nats-io/nats.go"
	log "github.com/sirupsen/logrus"
)

type NatsService struct {
	conn           *nats.Conn
	js             nats.JetStreamContext
	subjectHandler map[string][]func(data []byte)
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
		conn:           nc,
		js:             js,
		subjectHandler: make(map[string][]func([]byte)),
	}

	log.Info("NATS service initialized successfully")
	return service, nil
}

func (s *NatsService) InitializeStream(streamName string) error {
	// Create request stream
	_, err := s.js.AddStream(&nats.StreamConfig{
		Name:      streamName,
		Subjects:  []string{streamName + ".>"},
		Retention: nats.WorkQueuePolicy, // one-consumer-only
		Storage:   nats.FileStorage,
	})
	if err != nil && err != nats.ErrStreamNameAlreadyInUse {
		return fmt.Errorf("failed to create %s stream: %w", streamName, err)
	}

	log.Info("NATS streams initialized: %s", streamName)
	return nil
}

// PublishMessage publishes a message to NATS
func (s *NatsService) PublishMessage(streamName string, subject string, data []byte) (err error) {
	// TODO check if stream exists, otherwise init

	_, err = s.js.Publish(fmt.Sprintf("%s.%s", streamName, subject), data)
	if err != nil {
		return fmt.Errorf("failed to publish request to %s.%s: %w", streamName, subject, err)
	}

	log.Debugf("Published request to %s.%s", streamName, subject)
	return nil
}

// SubscribeToRequests subscribes to request messages and processes them with the provided handler
func (s *NatsService) SubscribeToSubject(streamName string, subject string, handler func(data []byte)) error {
	fullSubject := fmt.Sprintf("%s.%s", streamName, subject)
	handlers, exists := s.subjectHandler[fullSubject]
	s.subjectHandler[fullSubject] = append(handlers, handler)

	if !exists {
		_, err := s.js.Subscribe(fullSubject, func(msg *nats.Msg) {
			log.Debug("Received message on %s", fullSubject)

			handlers := s.subjectHandler[fullSubject]
			for _, handler := range handlers {
				handler(msg.Data)
			}

			msg.Ack()
		},
			nats.Durable(fmt.Sprintf("%s-%s-consumer", streamName, subject)),
			nats.AckExplicit(),
			nats.AckWait(10*time.Minute),
		)
		if err != nil {
			return fmt.Errorf("failed to subscribe to %s: %w", fullSubject, err)
		}
		log.Infof("Subscribed to %s", fullSubject)
	}

	return nil
}

// Close closes the NATS connection
func (s *NatsService) Close() {
	if s.conn != nil {
		s.conn.Close()
		log.Info("NATS connection closed")
	}
}
