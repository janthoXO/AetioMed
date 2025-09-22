-- Essential UMLS tables for disease-symptom mapping
-- Primary tables: MRCONSO, MRREL, MRSTY
-- Secondary tables: MRHIER, MRDEF, MRSAB

CREATE TABLE IF NOT EXISTS MRCONSO (
    CUI char(8) NOT NULL,
    LAT char(3) NOT NULL,
    TS char(1) NOT NULL,
    LUI varchar(10) NOT NULL,
    STT varchar(3) NOT NULL,
    SUI varchar(10) NOT NULL,
    ISPREF char(1) NOT NULL,
    AUI varchar(9) NOT NULL,
    SAUI varchar(50),
    SCUI varchar(100),
    SDUI varchar(100),
    SAB varchar(40) NOT NULL,
    TTY varchar(40) NOT NULL,
    CODE varchar(100) NOT NULL,
    STR text NOT NULL,
    SRL int unsigned NOT NULL,
    SUPPRESS char(1) NOT NULL,
    CVF int unsigned
) CHARACTER SET utf8mb4;

load data infile '/umls_data/MRCONSO.RRF' into
table MRCONSO fields terminated by '|' ESCAPED BY '' lines terminated by '\n' (
    @cui,
    @lat,
    @ts,
    @lui,
    @stt,
    @sui,
    @ispref,
    @aui,
    @saui,
    @scui,
    @sdui,
    @sab,
    @tty,
    @code,
    @str,
    @srl,
    @suppress,
    @cvf
)
SET
    CUI = @cui,
    LAT = @lat,
    TS = @ts,
    LUI = @lui,
    STT = @stt,
    SUI = @sui,
    ISPREF = @ispref,
    AUI = @aui,
    SAUI = NULLIF(@saui, ''),
    SCUI = NULLIF(@scui, ''),
    SDUI = NULLIF(@sdui, ''),
    SAB = @sab,
    TTY = @tty,
    CODE = @code,
    STR = @str,
    SRL = @srl,
    SUPPRESS = @suppress,
    CVF = NULLIF(@cvf, '');

CREATE TABLE IF NOT EXISTS MRREL (
    CUI1 char(8) NOT NULL,
    AUI1 varchar(9),
    STYPE1 varchar(50) NOT NULL,
    REL varchar(4) NOT NULL,
    CUI2 char(8) NOT NULL,
    AUI2 varchar(9),
    STYPE2 varchar(50) NOT NULL,
    RELA varchar(100),
    RUI varchar(10) NOT NULL,
    SRUI varchar(50),
    SAB varchar(40) NOT NULL,
    SL varchar(40) NOT NULL,
    RG varchar(10),
    DIR varchar(1),
    SUPPRESS char(1) NOT NULL,
    CVF int unsigned
) CHARACTER SET utf8mb4;

load data infile '/umls_data/MRREL.RRF' into
table MRREL fields terminated by '|' ESCAPED BY '' lines terminated by '\n' (
    @cui1,
    @aui1,
    @stype1,
    @rel,
    @cui2,
    @aui2,
    @stype2,
    @rela,
    @rui,
    @srui,
    @sab,
    @sl,
    @rg,
    @dir,
    @suppress,
    @cvf
)
SET
    CUI1 = @cui1,
    AUI1 = NULLIF(@aui1, ''),
    STYPE1 = @stype1,
    REL = @rel,
    CUI2 = @cui2,
    AUI2 = NULLIF(@aui2, ''),
    STYPE2 = @stype2,
    RELA = NULLIF(@rela, ''),
    RUI = @rui,
    SRUI = NULLIF(@srui, ''),
    SAB = @sab,
    SL = @sl,
    RG = NULLIF(@rg, ''),
    DIR = NULLIF(@dir, ''),
    SUPPRESS = @suppress,
    CVF = NULLIF(@cvf, '');

CREATE TABLE IF NOT EXISTS MRSTY (
    CUI char(8) NOT NULL,
    TUI char(4) NOT NULL,
    STN varchar(100) NOT NULL,
    STY varchar(50) NOT NULL,
    ATUI varchar(11) NOT NULL,
    CVF int unsigned
) CHARACTER SET utf8mb4;

load data infile '/umls_data/MRSTY.RRF' into
table MRSTY fields terminated by '|' ESCAPED BY '' lines terminated by '\n' (
    @cui,
    @tui,
    @stn,
    @sty,
    @atui,
    @cvf
)
SET
    CUI = @cui,
    TUI = @tui,
    STN = @stn,
    STY = @sty,
    ATUI = @atui,
    CVF = NULLIF(@cvf, '');

CREATE TABLE IF NOT EXISTS MRHIER (
    CUI char(8) NOT NULL,
    AUI varchar(9) NOT NULL,
    CXN int unsigned NOT NULL,
    PAUI varchar(10),
    SAB varchar(40) NOT NULL,
    RELA varchar(100),
    PTR text,
    HCD varchar(100),
    CVF int unsigned
) CHARACTER SET utf8mb4;

load data infile '/umls_data/MRHIER.RRF' into
table MRHIER fields terminated by '|' ESCAPED BY '' lines terminated by '\n' (
    @cui,
    @aui,
    @cxn,
    @paui,
    @sab,
    @rela,
    @ptr,
    @hcd,
    @cvf
)
SET
    CUI = @cui,
    AUI = @aui,
    CXN = @cxn,
    PAUI = NULLIF(@paui, ''),
    SAB = @sab,
    RELA = NULLIF(@rela, ''),
    PTR = NULLIF(@ptr, ''),
    HCD = NULLIF(@hcd, ''),
    CVF = NULLIF(@cvf, '');

CREATE TABLE IF NOT EXISTS MRDEF (
    CUI char(8) NOT NULL,
    AUI varchar(9) NOT NULL,
    ATUI varchar(11) NOT NULL,
    SATUI varchar(50),
    SAB varchar(40) NOT NULL,
    DEF text NOT NULL,
    SUPPRESS char(1) NOT NULL,
    CVF int unsigned
) CHARACTER SET utf8mb4;

load data infile '/umls_data/MRDEF.RRF' into
table MRDEF fields terminated by '|' ESCAPED BY '' lines terminated by '\n' (
    @cui,
    @aui,
    @atui,
    @satui,
    @sab,
    @def,
    @suppress,
    @cvf
)
SET
    CUI = @cui,
    AUI = @aui,
    ATUI = @atui,
    SATUI = NULLIF(@satui, ''),
    SAB = @sab,
    DEF = @def,
    SUPPRESS = @suppress,
    CVF = NULLIF(@cvf, '');

CREATE TABLE IF NOT EXISTS MRSAB (
    VCUI char(8),
    RCUI char(8),
    VSAB varchar(40) NOT NULL,
    RSAB varchar(40) NOT NULL,
    SON text NOT NULL,
    SF varchar(40) NOT NULL,
    SVER varchar(40),
    VSTART char(8),
    VEND char(8),
    IMETA varchar(10) NOT NULL,
    RMETA varchar(10),
    SLC text,
    SCC text,
    SRL int unsigned NOT NULL,
    TFR int unsigned,
    CFR int unsigned,
    CXTY varchar(50),
    TTYL varchar(400),
    ATNL text,
    LAT char(3),
    CENC varchar(40) NOT NULL,
    CURVER char(1) NOT NULL,
    SABIN char(1) NOT NULL,
    SSN text NOT NULL,
    SCIT text NOT NULL
) CHARACTER SET utf8mb4;

load data infile '/umls_data/MRSAB.RRF' into
table MRSAB fields terminated by '|' ESCAPED BY '' lines terminated by '\n' (
    @vcui,
    @rcui,
    @vsab,
    @rsab,
    @son,
    @sf,
    @sver,
    @vstart,
    @vend,
    @imeta,
    @rmeta,
    @slc,
    @scc,
    @srl,
    @tfr,
    @cfr,
    @cxty,
    @ttyl,
    @atnl,
    @lat,
    @cenc,
    @curver,
    @sabin,
    @ssn,
    @scit
)
SET
    VCUI = NULLIF(@vcui, ''),
    RCUI = @rcui,
    VSAB = @vsab,
    RSAB = @rsab,
    SON = @son,
    SF = @sf,
    SVER = NULLIF(@sver, ''),
    VSTART = NULLIF(@vstart, ''),
    VEND = NULLIF(@vend, ''),
    IMETA = @imeta,
    RMETA = NULLIF(@rmeta, ''),
    SLC = NULLIF(@slc, ''),
    SCC = NULLIF(@scc, ''),
    SRL = @srl,
    TFR = NULLIF(@tfr, ''),
    CFR = NULLIF(@cfr, ''),
    CXTY = NULLIF(@cxty, ''),
    TTYL = NULLIF(@ttyl, ''),
    ATNL = NULLIF(@atnl, ''),
    LAT = NULLIF(@lat, ''),
    CENC = @cenc,
    CURVER = @curver,
    SABIN = @sabin,
    SSN = @ssn,
    SCIT = @scit;