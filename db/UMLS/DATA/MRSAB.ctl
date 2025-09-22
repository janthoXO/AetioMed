options (direct=true)
load data
characterset UTF8 length semantics char
infile 'MRSAB.RRF'
badfile 'MRSAB.bad'
discardfile 'MRSAB.dsc'
truncate
into table MRSAB
fields terminated by '|'
trailing nullcols
(VCUI	char(8),
RCUI	char(8),
VSAB	char(40),
RSAB	char(40),
SON	char(3000),
SF	char(40),
SVER	char(40),
VSTART	char(8),
VEND	char(8),
IMETA	char(10),
RMETA	char(10),
SLC	char(1000),
SCC	char(1000),
SRL	integer external,
TFR	integer external,
CFR	integer external,
CXTY	char(50),
TTYL	char(400),
ATNL	char(4000),
LAT	char(3),
CENC	char(40),
CURVER	char(1),
SABIN	char(1),
SSN	char(3000),
SCIT	char(4000)
)