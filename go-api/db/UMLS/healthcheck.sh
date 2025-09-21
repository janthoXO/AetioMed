#!/bin/bash

# Check if MySQL is responsive
if ! mysqladmin ping -h localhost --silent; then
    echo "MySQL not ready"
    exit 1
fi

# Check if server is in read-only mode (indicates init complete)
READ_ONLY=$(mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -sN -e "SELECT @@read_only;")
if [ "$READ_ONLY" = "1" ]; then
    echo "MySQL initialized and ready"
    exit 0
else
    echo "MySQL ready but still initializing"
    exit 1
fi
