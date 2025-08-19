options (direct=true)
load data
characterset UTF8 length semantics char
infile 'MERGEDLUI.RRF'
badfile 'MERGEDLUI.bad'
discardfile 'MERGEDLUI.dsc'
truncate
into table MERGEDLUI
fields terminated by '|'
trailing nullcols
(PLUI	char(10),
LUI	char(10)
)