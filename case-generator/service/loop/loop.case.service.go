package loop

import (
	"case-generator/models"
	"case-generator/service"
	"context"

	log "github.com/sirupsen/logrus"
)

const ITERATIONS = 3

type LoopCaseService struct {
	anamnesisService    *service.AnamnesisService
	presentationService *service.PatientPresentationService
	consistencyService  *service.ConsistencyService
}

func NewLoopCaseService() *LoopCaseService {
	return &LoopCaseService{
		anamnesisService:    service.NewAnamnesisService(),
		presentationService: service.NewPatientPresentationService(),
		consistencyService:  service.NewConsistencyService(),
	}
}

func (s *LoopCaseService) GenerateWholeCase(ctx context.Context, diseaseName string, bitMask byte, symptoms []models.Symptom, patientPresentation models.PatientPresentation, anamnesis []models.Anamnesis, procedures []models.Procedure) (models.PatientPresentation, []models.Anamnesis, error) {

	// TODO pick symptoms for case first

	i := 0
	inconsistencyPrompts := make(map[string][]string)
	for {
		errChannel := make(chan error)

		// generate patient presentation
		presentationChannel := make(chan models.PatientPresentation)
		go func() {
			if bitMask&byte(models.PatientPresentationFlag) == 0 {
				log.Debug("Skipping Presentation Generation - no flag set")
				presentationChannel <- patientPresentation
				return
			}

			newPresentation, err := s.presentationService.GeneratePatientPresentation(ctx, diseaseName, symptoms, anamnesis, procedures, inconsistencyPrompts[models.PatientPresentationFlag.String()]...)
			if err != nil {
				errChannel <- err
				return
			}

			log.Debugf("New presentastion %+v\n", newPresentation)
			presentationChannel <- newPresentation
		}()

		// generate anamnesis
		anamnesisChannel := make(chan []models.Anamnesis)
		go func() {
			if bitMask&byte(models.AnamnesisFlag) == 0 {
				log.Debug("Skipping Anamnesis Generation - no flag set")
				anamnesisChannel <- anamnesis
				return
			}

			newAnamnesis, err := s.anamnesisService.GenerateAnamnesis(ctx, diseaseName, symptoms, patientPresentation, procedures)
			if err != nil {
				errChannel <- err
				return
			}

			log.Debugf("New anamnesis %+v\n", newAnamnesis)
			anamnesisChannel <- newAnamnesis
		}()

		// wait for results
		anamnesis = <-anamnesisChannel
		patientPresentation = <-presentationChannel

		// if an error occurs otherwise skip
		select {
		case err := <-errChannel:
			return patientPresentation, anamnesis, err
		default:
		}

		i++
		if i >= ITERATIONS {
			break
		}

		// Check for inconsistencies
		inconsistencies, err := s.consistencyService.CheckConsistency(ctx, diseaseName, symptoms, patientPresentation, anamnesis, procedures)
		if err != nil {
			return patientPresentation, anamnesis, err
		}
		// If no inconsistencies break
		if len(inconsistencies) == 0 {
			log.Debug("No inconsistencies found")
			break
		}

		log.Debugf("Inconsistencies: %+v\n", inconsistencies)
		for _, inconsistency := range inconsistencies {
			inconsistencyPrompts[inconsistency.Field] = append(inconsistencyPrompts[inconsistency.Field], inconsistency.PromptLine())
		}
	}

	// Return the final state from the context
	return patientPresentation, anamnesis, nil
}
