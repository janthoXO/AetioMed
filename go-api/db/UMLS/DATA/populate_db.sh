#!/bin/sh -f
#
# Essential UMLS tables import script for disease-symptom mapping
# Only imports: MRCONSO, MRREL, MRSTY, MRHIER, MRDEF, MRSAB
#

#
# Database connection parameters
#

MYSQL_HOST=my-sql
user=test
password=test
db_name=umls

/bin/rm -f mysql.log
touch mysql.log
ef=0
echo "See mysql.log for output"

echo "----------------------------------------" >> mysql.log 2>&1
echo "Starting tables import ... `/bin/date`" >> mysql.log 2>&1
echo "----------------------------------------" >> mysql.log 2>&1
echo "MYSQL_HOST = $MYSQL_HOST" >> mysql.log 2>&1
echo "user =       $user" >> mysql.log 2>&1
echo "db_name =    $db_name" >> mysql.log 2>&1

echo "    Create and load tables ... `/bin/date`" >> mysql.log 2>&1
mysql --local-infile=1 -h $MYSQL_HOST -vvv -u $user -p$password $db_name < mysql_tables.sql >> mysql.log 2>&1
if [ $? -ne 0 ]; then ef=1; fi

echo "finished loading tables ... `/bin/date`" >> mysql.log 2>&1

if [ $ef -ne 1 ]
then
echo "    Create indexes ... `/bin/date`" >> mysql.log 2>&1
mysql --local-infile=1 -h $MYSQL_HOST -vvv -u $user -p$password $db_name < mysql_indexes.sql >> mysql.log 2>&1
if [ $? -ne 0 ]; then ef=1; fi
fi

echo "finished indexes ... `/bin/date`" >> mysql.log 2>&1

echo "----------------------------------------" >> mysql.log 2>&1
if [ $ef -eq 1 ]
then
  echo "There were one or more errors.  Please reference the mysql.log file for details." >> mysql.log 2>&1
  retval=-1
else
  echo "Completed without errors." >> mysql.log 2>&1
  retval=0
fi
echo "Finished ... `/bin/date`" >> mysql.log 2>&1
echo "----------------------------------------" >> mysql.log 2>&1
exit $retval
