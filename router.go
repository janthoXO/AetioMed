package main

import (
	"case-generator/controller"

	"github.com/gin-gonic/gin"
)

func SetupRouter() *gin.Engine {
	r := gin.New()
	r.Use(gin.ErrorLogger())
	r.Use(gin.Recovery())

	patientPresentationController := controller.NewPatientPresentationController()
	anamnesisController := controller.NewAnamnesisController()

	r.POST("/disease/:diseaseName/anamnesis", anamnesisController.GenerateAnamnesis)
	r.POST("/disease/:diseaseName/patientPresentation", patientPresentationController.GeneratePatientPresentation)

	return r
}
