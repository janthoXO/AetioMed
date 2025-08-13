package main

import (
	"net/http"
	"disease-middleware/service"

	"github.com/gin-gonic/gin"

	log "github.com/sirupsen/logrus"
)

var symptomService = service.IcdService{}

func FetchSymptoms(c *gin.Context) {
	icd := c.Param("icd")

	symptoms, err := symptomService.FetchSymptoms(c.Request.Context(), icd)
	if err != nil {
		log.WithError(err).Error("Failed to fetch symptoms")
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, symptoms)
}
