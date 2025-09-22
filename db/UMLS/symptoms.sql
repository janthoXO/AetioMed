WITH
    disease AS (
        SELECT *
        FROM MRCONSO
        WHERE
            CODE = 'J00'
            AND SAB IN (
                'ICD10CM',
                'ICD10',
                'ICD10WHO'
            )
            AND LAT = 'ENG'
    ),
    related AS (
        SELECT rel.*
        FROM disease
            JOIN MRREL rel ON disease.CUI = rel.CUI1
        UNION
        SELECT rel.*
        FROM disease
            JOIN MRREL rel ON disease.CUI = rel.CUI2
    ),
    symptoms AS (
        SELECT DISTINCT
            sym.*
        FROM (
                SELECT s.*
                FROM related
                    JOIN MRCONSO s ON related.CUI2 = s.CUI
                WHERE
                    s.LAT = 'ENG'
                UNION
                SELECT s.*
                FROM related
                    JOIN MRCONSO s ON related.CUI1 = s.CUI
                WHERE
                    s.LAT = 'ENG'
            ) sym
            JOIN MRSTY semtype ON sym.CUI = semtype.CUI
        WHERE
            semtype.TUI = 'T184'
    )
SELECT DISTINCT symptoms.CUI, ANY_VALUE(symptoms.STR) AS STR, ANY_VALUE(def.DEF) AS DEF
FROM symptoms
LEFT JOIN MRDEF def ON symptoms.CUI = def.CUI
GROUP BY symptoms.CUI
