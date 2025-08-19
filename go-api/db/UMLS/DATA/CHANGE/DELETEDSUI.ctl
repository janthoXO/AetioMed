options (direct=true)
load data
characterset UTF8 length semantics char
infile 'DELETEDSUI.RRF'
badfile 'DELETEDSUI.bad'
discardfile 'DELETEDSUI.dsc'
truncate
into table DELETEDSUI
fields terminated by '|'
trailing nullcols
(PSUI	char(10),
LAT	char(3),
PSTR	char(3000)
)