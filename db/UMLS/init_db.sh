#!/bin/sh
set -e
cd /umls_data

/bin/rm -f mysql.log
touch mysql.log

echo "Disabling redo logging for faster bulk import..." >> mysql.log 2>&1
mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -e "ALTER INSTANCE DISABLE INNODB REDO_LOG;" >> mysql.log 2>&1

echo "Disable auto-commit and checks for faster import..." >> mysql.log 2>&1
mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -e "SET autocommit=0; SET unique_checks=0; SET foreign_key_checks=0;" >> mysql.log 2>&1

echo "Creating tables..." >> mysql.log 2>&1
mysql -uroot -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE" < /umls_data/01_create_tables.sql >> mysql.log 2>&1

echo "Creating indexes..." >> mysql.log 2>&1
mysql -uroot -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE" < /umls_data/02_create_indexes.sql >> mysql.log 2>&1

echo "Enabling auto-commit and checks again..." >> mysql.log 2>&1
mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -e "SET autocommit=1; SET unique_checks=1; SET foreign_key_checks=1;" >> mysql.log 2>&1

echo "Re-enabling redo logging..." >> mysql.log 2>&1
mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -e "ALTER INSTANCE ENABLE INNODB REDO_LOG;" >> mysql.log 2>&1

echo "Setting server to read-only..." >> mysql.log 2>&1
mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -e "SET GLOBAL read_only = ON; SET GLOBAL super_read_only = ON;" >> mysql.log 2>&1

# Delete data directory
# echo "Deleting data directory..." 
# rm -rf /umls_data/*
