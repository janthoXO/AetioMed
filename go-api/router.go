package main

import "github.com/gin-gonic/gin"

func SetupRouter() *gin.Engine {
	r := gin.New()
	r.Use(gin.ErrorLogger())
	r.Use(gin.Recovery())

	r.GET("/disease/:icd", FetchSymptoms)

	return r
}