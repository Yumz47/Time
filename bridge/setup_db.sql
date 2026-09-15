-- Create database and application user
CREATE DATABASE IF NOT EXISTS timeclock_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE USER IF NOT EXISTS 'timeclock_user'@'localhost' IDENTIFIED BY 'TimeClock@2026!';
ALTER USER 'timeclock_user'@'localhost' IDENTIFIED BY 'TimeClock@2026!';
GRANT ALL PRIVILEGES ON timeclock_db.* TO 'timeclock_user'@'localhost';
FLUSH PRIVILEGES;
