package controller

import (
	"case-generator/models"
	"case-generator/service"
	"net/http"

	"github.com/gin-gonic/gin"

	log "github.com/sirupsen/logrus"
)

type CaseController struct {
	CaseService *service.CaseService
}

func NewCaseController() *CaseController {
	return &CaseController{
		CaseService: service.NewCaseService(),
	}
}

type CaseRequestDTO struct {
	Symptoms            []models.Symptom           `json:"symptoms"`
	PatientPresentation models.PatientPresentation `json:"patientPresentation"`
	Anamnesis           []models.Anamnesis         `json:"anamnesis"`
}

func (controller *CaseController) GenerateWholeCase(c *gin.Context) {
	diseaseName := c.Param("diseaseName")

	// add flags which fields should be generated based on query parameters
	var bitMask byte
	if v, ok := c.GetQuery("patientPresentation"); ok && v == "true" {
		bitMask = bitMask | models.PatientPresentationFlag
	}
	if v, ok := c.GetQuery("anamnesis"); ok && v == "true" {
		bitMask = bitMask | models.AnamnesisFlag
	}
	// if no fields are specified, generate all fields
	if bitMask == 0 {
		bitMask = 0xFF
	}

	var requestDTO CaseRequestDTO
	err := c.ShouldBindJSON(&requestDTO)
	if err != nil {
		log.Errorf("Failed to bind JSON: %v", err)
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid JSON"})
		return
	}

	// Call the service to generate the case
	presentation, anamnesis, err := controller.CaseService.GenerateWholeCase(c, diseaseName, bitMask, requestDTO.Symptoms, requestDTO.PatientPresentation, requestDTO.Anamnesis)
	if err != nil {
		log.Errorf("Failed to generate case: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to generate case"})
		return
	}

	c.JSON(http.StatusOK, map[string]any{
		"patientPresentation": presentation,
		"anamnesis":           anamnesis,
	})
}
