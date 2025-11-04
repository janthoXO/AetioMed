package main

import (
	"case-generator/controller"

	"github.com/gin-gonic/gin"
)

func SetupRouter() *gin.Engine {
	r := gin.New()
	r.Use(gin.ErrorLogger())
	r.Use(gin.Recovery())

	caseController := controller.NewCaseController()
	treatmentReasonController := controller.NewTreatmentReasonController()
	anamnesisController := controller.NewAnamnesisController()
	procedureController := controller.NewProcedureController()

	r.POST("/disease/:diseaseName/case", caseController.GenerateWholeCase)
	r.POST("/disease/:diseaseName/anamnesis", anamnesisController.GenerateAnamnesis)
	r.POST("/disease/:diseaseName/treatmentReason", treatmentReasonController.GenerateTreatmentReason)
	r.POST("/disease/:diseaseName/procedures", procedureController.GenerateProcedures)

	return r
}
