options (direct=true)
load data
characterset UTF8 length semantics char
infile 'MRSTY.RRF'
badfile 'MRSTY.bad'
discardfile 'MRSTY.dsc'
truncate
into table MRSTY
fields terminated by '|'
trailing nullcols
(CUI	char(8),
TUI	char(4),
STN	char(100),
STY	char(50),
ATUI	char(11),
CVF	integer external
)