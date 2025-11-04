package controller

import (
	"case-generator/models"
	"case-generator/service"
	"net/http"

	"github.com/gin-gonic/gin"

	log "github.com/sirupsen/logrus"
	ilvimodels "gitlab.lrz.de/ILVI/ilvi/ilvi-api/model"
)

type TreatmentReasonController struct {
	TreatmentReasonService *service.TreatmentReasonService
}

func NewTreatmentReasonController() *TreatmentReasonController {
	return &TreatmentReasonController{
		TreatmentReasonService: service.NewTreatmentReasonService(),
	}
}

type TreatmentReasonRequestDTO struct {
	Symptoms   []models.Symptom       `json:"symptoms"`
	Anamnesis  []ilvimodels.Anamnesis `json:"anamnesis"`
	Procedures []models.Procedure     `json:"procedures"`
}

func (controller *TreatmentReasonController) GenerateTreatmentReason(c *gin.Context) {
	diseaseName := c.Param("diseaseName")

	var requestDTO TreatmentReasonRequestDTO
	err := c.ShouldBindJSON(&requestDTO)
	if err != nil {
		log.Errorf("Failed to bind JSON: %v", err)
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid JSON"})
		return
	}

	treatmentReason, err := controller.TreatmentReasonService.GenerateTreatmentReason(c, diseaseName, requestDTO.Symptoms, requestDTO.Anamnesis, requestDTO.Procedures)
	if err != nil {
		log.Errorf("Failed to generate treatment reason: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to generate treatment reason"})
		return
	}

	c.JSON(http.StatusOK, treatmentReason)
}
