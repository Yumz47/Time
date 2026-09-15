#!/usr/bin/env bash
set -e

echo "=== Setting up timeclock_db and user in MySQL ==="
if [ "$EUID" -ne 0 ]; then
    echo "Running with sudo to grant MySQL privileges..."
    sudo mysql < "$(dirname "$0")/bridge/setup_db.sql"
else
    mysql < "$(dirname "$0")/bridge/setup_db.sql"
fi

echo "=== Initializing database schema ==="
mysql -u timeclock_user -p'TimeClock@2026!' timeclock_db < "$(dirname "$0")/bridge/schema.sql"

echo "=== Verifying tables in timeclock_db ==="
mysql -u timeclock_user -p'TimeClock@2026!' -e "SHOW TABLES IN timeclock_db;"

echo "=== MySQL Database Setup Completed Successfully! ==="
