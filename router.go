package main

import (
	"disease-middleware/service"

	"github.com/gin-gonic/gin"

	log "github.com/sirupsen/logrus"
)

var llmService = service.NewLLMService()
var symptomService = &service.UmlsDbService{}
var procedureService = &service.UmlsDbService{}

func SetupRouter() *gin.Engine {
	r := gin.New()
	r.Use(gin.ErrorLogger())
	r.Use(gin.Recovery())

	log.Info("Using Symptom Service: ", symptomService.ServiceName())
	log.Info("Using Procedure Service: ", procedureService.ServiceName())

	r.GET("/disease/:icd/symptoms", func(c *gin.Context) {
		FetchSymptoms(c, symptomService)
	})

	r.GET("/disease/:icd/procedures", func(c *gin.Context) {
		FetchProceduresFromDisease(c, procedureService)
	})

	return r
}