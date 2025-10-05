package service

import (
	"context"
	"disease-middleware/db"
	"disease-middleware/models"

	log "github.com/sirupsen/logrus"
)

type UmlsDbService struct{}

func (s *UmlsDbService) ServiceName() string {
	return "UMLS Database Service"
}

func (s *UmlsDbService) FetchSymptoms(ctx context.Context, icd string) ([]models.Symptom, error) {
	if db.DB == nil {
		log.Error("Database not connected")
		return nil, nil
	}

	// SQL query to find symptoms related to a disease by ICD code
	query := `
	WITH
    disease AS (
        SELECT *
        FROM MRCONSO
        WHERE
            CODE = ?
            AND SAB IN (
                'ICD10CM',
                'ICD10',
                'ICD10WHO'
            )
            AND LAT = 'ENG'
    ),
    relatedCUIs AS (
        SELECT DISTINCT
            rel.CUI2 AS cui
        FROM disease
            JOIN MRREL rel ON disease.CUI = rel.CUI1
        UNION
        SELECT DISTINCT
            rel.CUI1 AS cui
        FROM disease
            JOIN MRREL rel ON disease.CUI = rel.CUI2
    ),
    symptomCUIs AS (
        SELECT relatedCUIs.*
        FROM relatedCUIs
            JOIN MRSTY semtype ON relatedCUIs.CUI = semtype.CUI
        WHERE
            semtype.TUI = 'T184'
    ),
    symptoms AS (
        SELECT DISTINCT MRCONSO.CUI, ANY_VALUE(MRCONSO.STR) AS STR
        FROM MRCONSO
            JOIN symptomCUIs ON MRCONSO.CUI = symptomCUIs.CUI
        WHERE
            MRCONSO.LAT = 'ENG'
        GROUP BY MRCONSO.CUI
    )
SELECT DISTINCT
    symptoms.CUI,
    ANY_VALUE(symptoms.STR) AS STR,
    ANY_VALUE(def.DEF) AS DEF
FROM symptoms
    LEFT JOIN MRDEF def ON symptoms.CUI = def.CUI
WHERE
    def.SAB = 'MSH'
GROUP BY
    symptoms.CUI
	`

	rows, err := db.DB.QueryContext(ctx, query, icd)
	if err != nil {
		log.WithError(err).Errorf("Failed to query symptoms for ICD code: %s", icd)
		return nil, err
	}
	defer rows.Close()

	var results []models.Symptom
	for rows.Next() {
		var cui, str string
		var def *string // Use pointer for nullable field

		if err := rows.Scan(&cui, &str, &def); err != nil {
			log.WithError(err).Error("Failed to scan symptom row")
			continue
		}

		symptom := models.Symptom{
			ID:          cui,
			Name:        str,
			MedicalName: str,
			Description: "",
			Severity:    nil,
			Frequency:   models.FrequencyCommon, // Default frequency
		}

		// Set description if definition exists
		if def != nil {
			symptom.Description = *def
		}

		results = append(results, symptom)
	}

	if err := rows.Err(); err != nil {
		log.WithError(err).Error("Error occurred during row iteration")
		return nil, err
	}

	log.Infof("Found %d symptoms for ICD code: %s", len(results), icd)
	return results, nil
}
