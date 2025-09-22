options (direct=true)
load data
characterset UTF8 length semantics char
infile 'MERGEDCUI.RRF'
badfile 'MERGEDCUI.bad'
discardfile 'MERGEDCUI.dsc'
truncate
into table MERGEDCUI
fields terminated by '|'
trailing nullcols
(PCUI	char(8),
CUI	char(8)
)