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

func (controller *PatientPresentationController) GeneratePatientPresentation(c *gin.Context) {
	diseaseName := c.Param("diseaseName")

	var symptoms []models.Symptom
	err := c.ShouldBindJSON(&symptoms)
	if err != nil {
		log.Errorf("Failed to bind JSON: %v", err)
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid JSON"})
		return
	}

	presentation, err := controller.PatientPresentationServie.GeneratePatientPresentation(c, diseaseName, symptoms)
	if err != nil {
		log.Errorf("Failed to generate patient presentation: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to generate patient presentation"})
		return
	}

	c.JSON(http.StatusOK, presentation)
}
