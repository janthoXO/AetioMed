package controller

import (
	"case-generator/models"
	"case-generator/service"
	"net/http"

	"github.com/gin-gonic/gin"

	log "github.com/sirupsen/logrus"
)

type AnamnesisController struct {
	AnamnesisService *service.AnamnesisService
}

func NewAnamnesisController() *AnamnesisController {
	return &AnamnesisController{
		AnamnesisService: service.NewAnamnesisService(),
	}
}

type AnamnesisRequestDTO struct {
	Symptoms 		  []models.Symptom            `json:"symptoms"`
	PatientPresentation models.PatientPresentation `json:"patientPresentation"`
}

func (controller *AnamnesisController) GenerateAnamnesis(c *gin.Context) {
	diseaseName := c.Param("diseaseName")

	var requestDTO AnamnesisRequestDTO
	err := c.ShouldBindJSON(&requestDTO)
	if err != nil {
		log.Errorf("Failed to bind JSON: %v", err)
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid JSON"})
		return
	}

	// Call the service to generate the anamnesis
	anamnesis, err := controller.AnamnesisService.GenerateAnamnesis(c, diseaseName, requestDTO.Symptoms, requestDTO.PatientPresentation)
	if err != nil {
		log.Errorf("Failed to generate anamnesis: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to generate anamnesis"})
		return
	}

	c.JSON(http.StatusOK, anamnesis)
}
