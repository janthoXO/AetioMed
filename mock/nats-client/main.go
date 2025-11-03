package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"time"

	"github.com/nats-io/nats.go"
	log "github.com/sirupsen/logrus"
)

func main() {
	// Command line flags
	natsURL := flag.String("url", "nats://localhost:4222", "NATS server URL")
	natsUser := flag.String("user", "nats", "NATS username")
	natsPass := flag.String("pass", "nats", "NATS password")
	flag.Parse()

	// Connect to NATS
	nc, err := nats.Connect(*natsURL, nats.UserInfo(*natsUser, *natsPass))
	if err != nil {
		log.Fatalf("Failed to connect to NATS: %v", err)
	}
	defer nc.Close()

	js, err := nc.JetStream()
	if err != nil {
		log.Fatalf("Failed to create JetStream context: %v", err)
	}

	log.Info("Connected to NATS")

	err = subscribeToSubject(js, "cases.generated")
	if err != nil {
		log.Fatalf("Failed to subscribe: %v", err)
	}

	log.Info("Subscribed to cases.generated")

	// Example: Generate Whole Case

	caseRequest := map[string]any{
		"diseaseName":     "Diabetes Mellitus",
		"generationFlags": []string{"treatmentReason"},
	}
	caseRequestBytes, _ := json.Marshal(caseRequest)

	publishRequest(js, "cases.generate", caseRequestBytes)

	// Wait for responses
	log.Info("Waiting for responses... (Press Ctrl+C to exit)")
	time.Sleep(1000 * time.Second)
}

func subscribeToSubject(js nats.JetStreamContext, subject string) error {
	// Subscribe to all responses
	_, err := js.Subscribe("cases.generated", func(msg *nats.Msg) {
		log.Infof("Received message on subject: %s", msg.Subject)

		var response map[string]any
		if err := json.Unmarshal(msg.Data, &response); err != nil {
			log.Errorf("Failed to unmarshal response: %v", err)
			msg.Ack()
			return
		}

		prettyJSON, _ := json.MarshalIndent(response, "", "  ")
		fmt.Printf("\n=== Response on %s ===\n%s\n", msg.Subject, string(prettyJSON))

		msg.Ack()
	},
		nats.Durable("example-case-generate"),
		nats.AckExplicit(),
	)

	return err
}

func publishRequest(js nats.JetStreamContext, subject string, data []byte) {
	_, err := js.Publish(subject, data, nats.AckWait(1000*time.Second))
	if err != nil {
		log.Errorf("Failed to publish to %s: %v", subject, err)
		return
	}

	log.Infof("Published request to %s", subject)
}
