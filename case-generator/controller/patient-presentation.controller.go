package controller

import (
	"case-generator/models"
	"case-generator/service"
	"net/http"

	"github.com/gin-gonic/gin"

	log "github.com/sirupsen/logrus"
)

type PatientPresentationController struct {
	PatientPresentationServie *service.PatientPresentationService
}

func NewPatientPresentationController() *PatientPresentationController {
	return &PatientPresentationController{
		PatientPresentationServie: service.NewPatientPresentationService(),
	}
}

type PresentationRequestDTO struct {
	Symptoms   []models.Symptom   `json:"symptoms"`
	Anamnesis  []models.Anamnesis `json:"anamnesis"`
	Procedures []models.Procedure `json:"procedures"`
}

func (controller *PatientPresentationController) GeneratePatientPresentation(c *gin.Context) {
	diseaseName := c.Param("diseaseName")

	var requestDTO PresentationRequestDTO
	err := c.ShouldBindJSON(&requestDTO)
	if err != nil {
		log.Errorf("Failed to bind JSON: %v", err)
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid JSON"})
		return
	}

	presentation, err := controller.PatientPresentationServie.GeneratePatientPresentation(c, diseaseName, requestDTO.Symptoms, requestDTO.Anamnesis, requestDTO.Procedures)
	if err != nil {
		log.Errorf("Failed to generate patient presentation: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to generate patient presentation"})
		return
	}

	c.JSON(http.StatusOK, presentation)
}
