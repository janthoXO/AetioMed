package controller

import (
	"case-generator/models"
	natsservice "case-generator/nats"
	"case-generator/service"
	"case-generator/service/loop"
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/nats-io/nats.go"

	log "github.com/sirupsen/logrus"
)

type CaseNatsHandler struct {
	caseService service.CaseService
}

func NewCaseNatsHandler() *CaseNatsHandler {
	return &CaseNatsHandler{
		caseService: loop.NewLoopCaseService(),
	}
}

// RegisterHandler registers all NATS message handlers
func (h *CaseNatsHandler) RegisterHandler() error {
	// Register whole case handler
	err := natsservice.NatsServiceInstance.SubscribeToSubject(
		"cases.generate",
		h.handleGenerateWholeCase,
		nats.Durable(fmt.Sprintf("%s-%s-consumer", "cases", "generate")),
		nats.AckExplicit(),
		nats.AckWait(10*time.Minute),
	)
	if err != nil {
		return fmt.Errorf("failed to register case handler: %w", err)
	}

	log.Info("All NATS handlers registered successfully")
	return nil
}

type CaseNatsRequest struct {
	DiseaseName     string                 `json:"diseaseName"`
	GenerationFlags []string               `json:"generationFlags"`
	Symptoms        []models.Symptom       `json:"symptoms"`
	TreatmentReason string                 `json:"treatmentReason"`
	Anamnesis       []models.Anamnesis `json:"anamnesis"`
	Procedures      []models.Procedure     `json:"procedures"`
}

type CaseNatsResponse struct {
	TreatmentReason string                 `json:"treatmentReason"`
	Anamnesis       []models.Anamnesis `json:"anamnesis"`
	Procedures      []models.Procedure     `json:"procedures"`
}

func (h *CaseNatsHandler) handleGenerateWholeCase(msg *nats.Msg) {
	var request CaseNatsRequest
	if err := json.Unmarshal(msg.Data, &request); err != nil {
		log.Errorf("Failed to unmarshal case request: %v", err)
		return
	}

	var bitMask byte
	for _, flagString := range request.GenerationFlags {
		flag, ok := models.StringToFieldFlag(flagString)
		if !ok {
			log.Errorf("Unknown generation flag: %s", flagString)
			continue
		}

		bitMask |= byte(flag)
	}
	// If no bitmask specified, generate all fields
	if bitMask == 0 {
		bitMask = 0xFF
	}

	log.Debugf("Processing whole case request for disease: %s with bitmask: %08b", request.DiseaseName, bitMask)

	treatmentReason, anamnesis, err := h.caseService.GenerateWholeCase(
		context.Background(),
		request.DiseaseName,
		bitMask,
		request.Symptoms,
		request.TreatmentReason,
		request.Anamnesis,
		request.Procedures,
	)
	if err != nil {
		log.Errorf("Failed to generate case: %v", err)
		return
	}

	// TODO publish response back to NATS
	responseData, err := json.Marshal(CaseNatsResponse{
		TreatmentReason: treatmentReason,
		Anamnesis:       anamnesis,
		Procedures:      nil,
	})
	if err != nil {
		log.Errorf("Failed to marshal case response: %v", err)
		return
	}

	err = natsservice.NatsServiceInstance.PublishMessage("cases.generated", responseData)
	if err != nil {
		log.Errorf("Failed to publish response: %v", err)
		return
	}
}
