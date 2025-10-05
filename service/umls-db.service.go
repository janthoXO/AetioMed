package service

import (
	"context"
	"disease-middleware/db"
	"disease-middleware/models"
	"fmt"
	"strings"

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
	query, err := db.DB.Prepare(`
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
	`)
	if err != nil {
		log.WithError(err).Error("Failed to prepare query for symptoms")
		return nil, err
	}
	defer query.Close()

	rows, err := query.QueryContext(ctx, icd)
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

	log.Debugf("Found %d symptoms for ICD code: %s", len(results), icd)
	return results, nil
}

func (s *UmlsDbService) FetchProceduresFromSymptoms(ctx context.Context, symptomIds []string) ([]models.Procedure, error) {
	if db.DB == nil {
		log.Error("Database not connected")
		return nil, nil
	}

	// SQL query to find symptoms related to a disease by ICD code
	queryString :=`
WITH
    relatedCUIs AS (
        SELECT DISTINCT
            rel.CUI2 AS cui
        FROM MRREL rel
        WHERE
            rel.CUI1 IN (%s)
        UNION
        SELECT DISTINCT
            rel.CUI1 AS cui
        FROM MRREL rel
        WHERE
            rel.CUI2 IN (%s)
    ),
    procedureCUIs AS (
        SELECT relatedCUIs.CUI
        FROM relatedCUIs
            JOIN MRSTY semtype ON relatedCUIs.CUI = semtype.CUI
        WHERE
            semtype.TUI = 'T034' -- T034 = Laboratory or Test Result
            OR semtype.TUI = 'T059' -- T059 = Laboratory Procedure
            OR semtype.TUI = 'T060' -- T060 = Diagnostic Procedure
            OR semtype.TUI = 'T061' -- T061 = Therapeutic or Preventive Procedure
    ),
    procedures AS (
        SELECT DISTINCT
            MRCONSO.CUI,
            ANY_VALUE(MRCONSO.STR) AS STR
        FROM MRCONSO
            JOIN procedureCUIs ON MRCONSO.CUI = procedureCUIs.CUI
        WHERE
            MRCONSO.LAT = 'ENG'
        GROUP BY
            MRCONSO.CUI
    )
SELECT DISTINCT
    procedures.CUI,
    ANY_VALUE(procedures.STR) AS STR,
    ANY_VALUE(def.DEF) AS DEF
FROM procedures
    LEFT JOIN MRDEF def ON procedures.CUI = def.CUI
WHERE
    def.SAB = 'MSH'
GROUP BY
    procedures.CUI
	`
    placeholder := strings.Repeat("?,", len(symptomIds))
	placeholder = strings.TrimSuffix(placeholder, ",")
	query, err := db.DB.PrepareContext(
		ctx,
		fmt.Sprintf(queryString, placeholder, placeholder),
	)
	if err != nil {
		log.WithError(err).Error("Failed to prepare query for procedures from symptoms")
		return nil, err
	}
	defer query.Close()

	inputArray := make([]any, len(symptomIds) * 2)
	for i, id := range symptomIds {
		inputArray[i] = id
		inputArray[i + len(symptomIds)] = id
	}
	rows, err := query.QueryContext(ctx, inputArray...)
	if err != nil {
		log.WithError(err).Errorf("Failed to query procedures from symptoms for symptom ids: %v", symptomIds)
		return nil, err
	}
	defer rows.Close()

	var results []models.Procedure
	for rows.Next() {
		var cui, str string
		var def *string // Use pointer for nullable field

		if err := rows.Scan(&cui, &str, &def); err != nil {
			log.WithError(err).Error("Failed to scan procedure row")
			continue
		}

		procedure := models.Procedure{
			ID:          cui,
			Name:        str,
			Description: "",
		}

		// Set description if definition exists
		if def != nil {
			procedure.Description = *def
		}

		results = append(results, procedure)
	}

	if err := rows.Err(); err != nil {
		log.WithError(err).Error("Error occurred during row iteration")
		return nil, err
	}

	log.Debugf("Found %d procedures for symptom ids: %v", len(results), symptomIds)
	return results, nil
}

func (s *UmlsDbService) FetchProceduresFromDisease(ctx context.Context, icd string) ([]models.Procedure, error) {
	if db.DB == nil {
		log.Error("Database not connected")
		return nil, nil
	}

	// SQL query to find procedures related to a disease by ICD code
	query, err := db.DB.Prepare(`
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
    procedureCUIs AS (
        SELECT relatedCUIs.CUI
        FROM relatedCUIs
            JOIN MRSTY semtype ON relatedCUIs.CUI = semtype.CUI
        WHERE
            semtype.TUI = 'T034' -- T034 = Laboratory or Test Result
            OR semtype.TUI = 'T059' -- T059 = Laboratory Procedure
            OR semtype.TUI = 'T060' -- T060 = Diagnostic Procedure
            OR semtype.TUI = 'T061' -- T061 = Therapeutic or Preventive Procedure
    ),
    procedures AS (
        SELECT DISTINCT
            MRCONSO.CUI,
            ANY_VALUE(MRCONSO.STR) AS STR
        FROM MRCONSO
            JOIN procedureCUIs ON MRCONSO.CUI = procedureCUIs.CUI
        WHERE
            MRCONSO.LAT = 'ENG'
        GROUP BY
            MRCONSO.CUI
    )
SELECT DISTINCT
    procedures.CUI,
    ANY_VALUE(procedures.STR) AS STR,
    ANY_VALUE(def.DEF) AS DEF
FROM procedures
    LEFT JOIN MRDEF def ON procedures.CUI = def.CUI
WHERE
    def.SAB = 'MSH'
GROUP BY
    procedures.CUI
	`)
	if err != nil {
		log.WithError(err).Error("Failed to prepare query for procedures from disease")
		return nil, err
	}
	defer query.Close()

	rows, err := query.QueryContext(ctx, icd)
	if err != nil {
		log.WithError(err).Errorf("Failed to query procedures from disease icd: %s", icd)
		return nil, err
	}
	defer rows.Close()

	var results []models.Procedure
	for rows.Next() {
		var cui, str string
		var def *string // Use pointer for nullable field

		if err := rows.Scan(&cui, &str, &def); err != nil {
			log.WithError(err).Error("Failed to scan procedure row")
			continue
		}

		procedure := models.Procedure{
			ID:          cui,
			Name:        str,
			Description: "",
		}

		// Set description if definition exists
		if def != nil {
			procedure.Description = *def
		}

		results = append(results, procedure)
	}

	if err := rows.Err(); err != nil {
		log.WithError(err).Error("Error occurred during row iteration")
		return nil, err
	}

	log.Debugf("Found %d procedures for disease icd: %s", len(results), icd)
	return results, nil
}
