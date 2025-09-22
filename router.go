package main

import (
	"disease-middleware/service"

	"github.com/gin-gonic/gin"

	log "github.com/sirupsen/logrus"
)

var llmService = service.NewLLMService()
var symptomService = service.NewAiService(llmService)

func SetupRouter() *gin.Engine {
	r := gin.New()
	r.Use(gin.ErrorLogger())
	r.Use(gin.Recovery())

	log.Info("Using Symptom Service: ", symptomService.ServiceName())

	r.GET("/disease/:icd", func(c *gin.Context) {
		FetchSymptoms(c, symptomService)
	})

	return r
}