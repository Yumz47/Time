-- Schema for Time & Attendance System
CREATE DATABASE IF NOT EXISTS timeclock_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE timeclock_db;

-- 1. Departments table
CREATE TABLE IF NOT EXISTS departments (
    dept_id INT PRIMARY KEY,
    dept_name VARCHAR(100) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- 2. Employees table
CREATE TABLE IF NOT EXISTS employees (
    user_id INT PRIMARY KEY,
    badge_number VARCHAR(50),
    name VARCHAR(100) NOT NULL,
    gender VARCHAR(20),
    dept_id INT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_dept (dept_id),
    CONSTRAINT fk_emp_dept FOREIGN KEY (dept_id) REFERENCES departments(dept_id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- 3. Check In / Check Out punches
CREATE TABLE IF NOT EXISTS checkinout (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    check_time DATETIME NOT NULL,
    check_type VARCHAR(10) NOT NULL,
    normalized_type ENUM('in', 'out') NOT NULL,
    sensor_id VARCHAR(50),
    work_code INT DEFAULT 0,
    sn VARCHAR(50),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uk_user_checktime (user_id, check_time),
    INDEX idx_user_id (user_id),
    INDEX idx_check_time (check_time),
    INDEX idx_user_time (user_id, check_time),
    INDEX idx_norm_type (normalized_type),
    CONSTRAINT fk_punch_emp FOREIGN KEY (user_id) REFERENCES employees(user_id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 4. Sync metadata and audit log
CREATE TABLE IF NOT EXISTS sync_log (
    id INT AUTO_INCREMENT PRIMARY KEY,
    sync_start DATETIME NOT NULL,
    sync_end DATETIME,
    records_read INT DEFAULT 0,
    records_inserted INT DEFAULT 0,
    status VARCHAR(50) DEFAULT 'SUCCESS',
    error_message TEXT
) ENGINE=InnoDB;
