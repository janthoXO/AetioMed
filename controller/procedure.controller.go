package controller

import (
	"case-generator/models"
	"case-generator/service"
	"net/http"

	"github.com/gin-gonic/gin"

	log "github.com/sirupsen/logrus"
)

type ProcedureController struct {
	ProcedureService *service.ProcedureService
}

func NewProcedureController() *ProcedureController {
	return &ProcedureController{
		ProcedureService: service.NewProcedureService(),
	}
}

func (controller *ProcedureController) GenerateProcedures(c *gin.Context) {
	diseaseName := c.Param("diseaseName")

	var symptoms []models.Symptom
	err := c.ShouldBindJSON(&symptoms)
	if err != nil {
		log.Errorf("Failed to bind JSON: %v", err)
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid JSON"})
		return
	}

	// Call the service to generate the anamnesis
	procedures, err := controller.ProcedureService.GetProcedure(c, diseaseName, symptoms)
	if err != nil {
		log.Errorf("Failed to generate procedures: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to generate procedures"})
		return
	}

	c.JSON(http.StatusOK, procedures)
}
