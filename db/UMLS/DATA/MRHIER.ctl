options (direct=true)
load data
characterset UTF8 length semantics char
infile 'MRHIER.RRF'
badfile 'MRHIER.bad'
discardfile 'MRHIER.dsc'
truncate
into table MRHIER
fields terminated by '|'
trailing nullcols
(CUI	char(8),
AUI	char(9),
CXN	integer external,
PAUI	char(10),
SAB	char(40),
RELA	char(100),
PTR	char(1000),
HCD	char(100),
CVF	integer external
)