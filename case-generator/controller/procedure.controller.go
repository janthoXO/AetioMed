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

type ProcedureRequestDTO struct {
	DiseaseProcedures []models.Procedure `json:"diseaseProcedures"`
	SymptomProcedures []models.Procedure `json:"symptomProcedures"`
}

func (controller *ProcedureController) GenerateProcedures(c *gin.Context) {
	var proceduresRequestDTO ProcedureRequestDTO
	err := c.ShouldBindJSON(&proceduresRequestDTO)
	if err != nil {
		log.Errorf("Failed to bind JSON: %v", err)
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid JSON"})
		return
	}

	// Call the service to match the procedures
	procedures, err := controller.ProcedureService.MatchProcedures(c, proceduresRequestDTO.DiseaseProcedures, proceduresRequestDTO.SymptomProcedures)
	if err != nil {
		log.Errorf("Failed to generate procedures: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to generate procedures"})
		return
	}

	c.JSON(http.StatusOK, procedures)
}
