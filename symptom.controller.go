package main

import (
	"disease-middleware/service"
	"net/http"

	"github.com/gin-gonic/gin"

	log "github.com/sirupsen/logrus"
)

func FetchSymptoms(c *gin.Context, symptomService service.SymptomService) {
	icd := c.Param("icd")

	symptoms, err := symptomService.FetchSymptoms(c.Request.Context(), icd)
	if err != nil {
		log.WithError(err).Error("Failed to fetch symptoms")
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, symptoms)
}
