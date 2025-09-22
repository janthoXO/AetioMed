options (direct=true)
load data
characterset UTF8 length semantics char
infile 'MRREL.RRF'
badfile 'MRREL.bad'
discardfile 'MRREL.dsc'
truncate
into table MRREL
fields terminated by '|'
trailing nullcols
(CUI1	char(8),
AUI1	char(9),
STYPE1	char(50),
REL	char(4),
CUI2	char(8),
AUI2	char(9),
STYPE2	char(50),
RELA	char(100),
RUI	char(10),
SRUI	char(50),
SAB	char(40),
SL	char(40),
RG	char(10),
DIR	char(1),
SUPPRESS	char(1),
CVF	integer external
)