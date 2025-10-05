package main

import (
	"disease-middleware/models"
	"disease-middleware/service"
	"net/http"

	"github.com/gin-gonic/gin"

	log "github.com/sirupsen/logrus"
)

type ProcedureDTO struct {
	DiseaseProcedures []models.Procedure `json:"diseaseProcedures"`
	SymptomProcedures []models.Procedure `json:"symptomProcedures"`
}

func FetchProceduresFromDisease(c *gin.Context, procedureService service.ProcedureService) {
	icd := c.Param("icd")

	var symptomIds []string
	if err := c.ShouldBindJSON(&symptomIds); err != nil {
		log.WithError(err).Error("Failed to bind JSON")
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	diseaseProcedures, err := procedureService.FetchProceduresFromDisease(c.Request.Context(), icd)
	if err != nil {
		log.WithError(err).Error("Failed to fetch procedures")
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	symptomProcedures, err := procedureService.FetchProceduresFromSymptoms(c.Request.Context(), symptomIds)
	if err != nil {
		log.WithError(err).Error("Failed to fetch procedures")
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	procedures := ProcedureDTO{
		DiseaseProcedures: diseaseProcedures,
		SymptomProcedures: symptomProcedures,
	}

	c.JSON(http.StatusOK, procedures)
}
