package controller

import (
	"case-generator/models"
	"case-generator/service"
	"case-generator/service/loop"
	"net/http"

	"github.com/gin-gonic/gin"

	log "github.com/sirupsen/logrus"
)

type CaseController struct {
	CaseService service.CaseService
}

func NewCaseController() *CaseController {
	return &CaseController{
		CaseService: loop.NewLoopCaseService(),
	}
}

type CaseRequestDTO struct {
	Symptoms        []models.Symptom   `json:"symptoms"`
	TreatmentReason string             `json:"treatmentReason"`
	Anamnesis       []models.Anamnesis `json:"anamnesis"`
	Procedures      []models.Procedure `json:"procedures"`
}

func (controller *CaseController) GenerateWholeCase(c *gin.Context) {
	diseaseName := c.Param("diseaseName")

	// add flags which fields should be generated based on query parameters
	var bitMask byte
	if v, ok := c.GetQuery("treatmentReason"); ok && v == "true" {
		bitMask = bitMask | byte(models.TreatmentReasonFlag)
	}
	if v, ok := c.GetQuery("anamnesis"); ok && v == "true" {
		bitMask = bitMask | byte(models.AnamnesisFlag)
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

	log.Debugf("Generating case for disease: %s with bitmask: %08b", diseaseName, bitMask)

	// Call the service to generate the case
	treatmentReason, anamnesis, err := controller.CaseService.GenerateWholeCase(c, diseaseName, bitMask, requestDTO.Symptoms, requestDTO.TreatmentReason, requestDTO.Anamnesis, requestDTO.Procedures)
	if err != nil {
		log.Errorf("Failed to generate case: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to generate case"})
		return
	}

	c.JSON(http.StatusOK, map[string]any{
		"treatmentReason": treatmentReason,
		"anamnesis":       anamnesis,
	})
}
