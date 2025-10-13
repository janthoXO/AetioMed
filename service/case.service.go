package service

import (
	"case-generator/models"
	"case-generator/utils"
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/tmc/langchaingo/agents"
	"github.com/tmc/langchaingo/llms/ollama"
	"github.com/tmc/langchaingo/tools"

	log "github.com/sirupsen/logrus"
)

type CaseService struct {
	llmService *LLMService
}

func NewCaseService() *CaseService {
	return &CaseService{
		llmService: GetLLMService(),
	}
}

// CaseContext holds all the state for case generation
type CaseContext struct {
	DiseaseName         string
	ContextSymptoms     []models.Symptom
	PatientPresentation models.PatientPresentation
	Anamnesis           []models.Anamnesis
}

func (s *CaseService) GenerateWholeCase(ctx context.Context, diseaseName string, bitMask byte, symptoms []models.Symptom, patientPresentation models.PatientPresentation, anamnesis []models.Anamnesis) (models.PatientPresentation, []models.Anamnesis, error) {
	log.Debugf("Generating case for disease: %s with bitmask: %08b", diseaseName, bitMask)

	// Create langchain Ollama LLM
	llm, err := ollama.New(
		ollama.WithServerURL(utils.Cfg.OllamaApi.Url),
		ollama.WithModel(utils.Cfg.OllamaApi.Model),
	)
	if err != nil {
		return models.PatientPresentation{}, nil, fmt.Errorf("failed to create LLM: %w", err)
	}

	// Create case context with input data
	caseCtx := &CaseContext{
		DiseaseName:         diseaseName,
		ContextSymptoms:     symptoms,
		PatientPresentation: patientPresentation,
		Anamnesis:           anamnesis,
	}

	// Create tools for the agent
	agentTools := []tools.Tool{
		NewGenerateSymptomsTool(caseCtx, s.llmService),
		NewGetCurrentStateTool(caseCtx),
		NewCheckConsistencyTool(caseCtx, s.llmService),
	}

	// Determine what needs to be generated
	var tasks []string
	if bitMask&models.PatientPresentationFlag != 0 {
		tasks = append(tasks, "treatment reason")
		agentTools = append(agentTools, NewGenerateTreatmentReasonTool(caseCtx, s.llmService))
	}
	if bitMask&models.AnamnesisFlag != 0 {
		tasks = append(tasks, "anamnesis")
		agentTools = append(agentTools, NewGenerateAnamnesisTool(caseCtx, s.llmService))
	}
	taskList := strings.Join(tasks, ", ")

	// Create the agent and executor
	agent := agents.NewOneShotAgent(
		llm,
		agentTools,
		agents.WithMaxIterations(15),
	)
	agentExecutor := agents.NewExecutor(agent)

	// Build the agent prompt
	prompt := fmt.Sprintf(`You are a medical case generator agent. Your task is to generate a realistic clinical case for %s.

Tasks to complete:
- Generate the following fields: %s
- After generating all fields, check the consistency of all data
- If inconsistencies are found, regenerate the inconsistent fields

Available tools:
1. GenerateTreatmentReason - generates the patient's chief complaint
2. GenerateSymptoms - generates detailed symptoms list
3. GenerateAnamnesis - generates medical history questions and answers
4. GetCurrentState - shows what has been generated so far
5. CheckConsistency - validates consistency across all fields

Work step by step:
1. Use GetCurrentState to see what's already provided
2. Generate each specified field using the appropriate tool
3. Use CheckConsistency to validate everything
4. If issues found, regenerate problematic fields
5. When everything is consistent, respond with "FINAL ANSWER: Case generation complete"

Begin!`, diseaseName, taskList)

	// Execute the agent
	result, err := agentExecutor.Call(ctx, map[string]any{
		"input": prompt,
	})
	if err != nil {
		log.Warnf("Agent execution had issues: %v", err)
		// Return what we have even if agent had issues
	} else {
		log.Debugf("Agent result: %v", result)
	}

	// Return the final state from the context
	return caseCtx.PatientPresentation, caseCtx.Anamnesis, nil
}

// GetCurrentStateTool shows the current state of generation
type GetCurrentStateTool struct {
	ctx *CaseContext
}

func NewGetCurrentStateTool(ctx *CaseContext) *GetCurrentStateTool {
	return &GetCurrentStateTool{ctx: ctx}
}

func (t *GetCurrentStateTool) Name() string {
	return "GetCurrentState"
}

func (t *GetCurrentStateTool) Description() string {
	return "Shows the current state of the case generation including what has been provided and what has been generated. Input should be empty or 'show'."
}

func (t *GetCurrentStateTool) Call(ctx context.Context, input string) (string, error) {
	state := map[string]any{
		"diseaseName":     t.ctx.DiseaseName,
		"contextSymptoms": t.ctx.ContextSymptoms,
		"patientPresentation": map[string]any{
			"treatmentReason": t.ctx.PatientPresentation.TreatmentReason,
			"symptoms":        t.ctx.PatientPresentation.Symptoms,
		},
		"anamnesis": t.ctx.Anamnesis,
	}

	stateJSON, _ := json.MarshalIndent(state, "", "  ")
	return string(stateJSON), nil
}
