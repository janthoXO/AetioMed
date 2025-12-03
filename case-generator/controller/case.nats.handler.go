package controller

import (
	"case-generator/models"
	natsservice "case-generator/nats"
	"case-generator/service"
	"case-generator/service/loop"
	"case-generator/utils"
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/nats-io/nats.go"
	"gitlab.lrz.de/ILVI/ilvi/ilvi-api/controller/dto"

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
		nats.AckWait(10*time.Minute), // TODO use inProgress heartbeats instead
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
	Anamnesis       []dto.AnamnesisPayload `json:"anamnesis"`
	Procedures      []models.Procedure     `json:"procedures"`
}

type CaseNatsResponse struct {
	TreatmentReason string                 `json:"treatmentReason"`
	Anamnesis       []dto.AnamnesisPayload `json:"anamnesis"`
	Procedures      []models.Procedure     `json:"procedures"`
}

func (h *CaseNatsHandler) handleGenerateWholeCase(msg *nats.Msg) error {
	caseId := msg.Header.Get("Case-Id")
	patientFileId := msg.Header.Get("Patient-File-Id")

	var request CaseNatsRequest
	if err := json.Unmarshal(msg.Data, &request); err != nil {
		log.Errorf("Failed to unmarshal case request: %v", err)
		return fmt.Errorf("Failed to unmarshal case generation request")
	}

	var bitMask byte
	for _, flagString := range request.GenerationFlags {
		flag, ok := models.StringToFieldFlag(flagString)
		if !ok {
			log.Errorf("Unknown generation flag: %s", flagString)
			continue
		}

		if flag == models.TreatmentReasonFlag && caseId == ""{
			log.Errorf("Treatment reason generation requested but Case ID is missing")
			return fmt.Errorf("Treatment reason generation requested but Case ID is missing")
		} 
		if flag == models.AnamnesisFlag && patientFileId == ""{
			log.Errorf("Anamnesis generation requested but Patient File ID is missing")
			return fmt.Errorf("Anamnesis generation requested but Patient File ID is missing")
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
		utils.MapSlice(request.Anamnesis, func(a dto.AnamnesisPayload) models.Anamnesis {
			return models.Anamnesis{
				AnamnesisPayload: a,
			}
		}),
		request.Procedures,
	)
	if err != nil {
		log.Errorf("Failed to generate case: %v", err)
		return fmt.Errorf("Failed to generate case: %v", err)
	}

	log.Debugf("Generated Case\n treatmentReason: %s\nanamnesis %+v", treatmentReason, anamnesis)

	// TODO publish response back to NATS
	responseData, err := json.Marshal(CaseNatsResponse{
		TreatmentReason: treatmentReason,
		Anamnesis: utils.MapSlice(anamnesis, func(a models.Anamnesis) dto.AnamnesisPayload {
			return dto.AnamnesisPayload{
				ID:       a.ID,
				Category: a.Category,
				Answer:   a.Answer,
			}
		}),
		Procedures: nil,
	})
	if err != nil {
		log.Errorf("Failed to marshal case response: %v", err)
		return fmt.Errorf("Failed to marshal case generation response")
	}

	log.Debugf("Publishing response for case ID %s, patientFile ID %s: %s", caseId, patientFileId, responseData)

	err = natsservice.NatsServiceInstance.PublishMessage(&nats.Msg{
		Subject: "cases.generated",
		Data:    responseData,
		Header:  nats.Header{"Case-Id": []string{caseId}, "Patient-File-Id": []string{patientFileId}},
	})
	if err != nil {
		log.Errorf("Failed to publish response: %v", err)
		return fmt.Errorf("Failed to publish case generation response")
	}

	return nil
}
