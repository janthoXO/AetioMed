options (direct=true)
load data
characterset UTF8 length semantics char
infile 'DELETEDCUI.RRF'
badfile 'DELETEDCUI.bad'
discardfile 'DELETEDCUI.dsc'
truncate
into table DELETEDCUI
fields terminated by '|'
trailing nullcols
(PCUI	char(8),
PSTR	char(3000)
)