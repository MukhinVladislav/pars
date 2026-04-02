-- 001_query_learning_and_locking.sql
-- Apply once in your MySQL/MariaDB database (ci70535_yt)

-- NOTE:
-- Old MySQL/MariaDB builds may not support `ADD COLUMN IF NOT EXISTS`.
-- This block is compatible with older versions.

-- 1) Add source_query to chanels (only if missing)
SET @col_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'chanels'
    AND COLUMN_NAME = 'source_query'
);

SET @sql_add_col := IF(
  @col_exists = 0,
  'ALTER TABLE `chanels` ADD COLUMN `source_query` VARCHAR(255) NULL DEFAULT NULL',
  'SELECT 1'
);

PREPARE stmt_add_col FROM @sql_add_col;
EXECUTE stmt_add_col;
DEALLOCATE PREPARE stmt_add_col;

-- 2) Queries table (self-learning search queue)
CREATE TABLE IF NOT EXISTS `queries` (
  `query` VARCHAR(255) NOT NULL,
  `weight` INT NOT NULL DEFAULT 1,
  `tries` INT NOT NULL DEFAULT 0,
  `wins` INT NOT NULL DEFAULT 0,
  `disabled` TINYINT(1) NOT NULL DEFAULT 0,
  `last_used_at` INT NULL DEFAULT NULL,
  `created_at` INT NOT NULL DEFAULT 0,
  PRIMARY KEY (`query`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- 3) Optional negatives table (stop-words)
CREATE TABLE IF NOT EXISTS `negatives` (
  `term` VARCHAR(255) NOT NULL,
  `weight` INT NOT NULL DEFAULT 1,
  `created_at` INT NOT NULL DEFAULT 0,
  PRIMARY KEY (`term`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- 4) Helpful index for queue scan (only if missing)
SET @idx_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'chanels'
    AND INDEX_NAME = 'idx_chanels_status'
);

SET @sql_add_idx := IF(
  @idx_exists = 0,
  'CREATE INDEX `idx_chanels_status` ON `chanels` (`status`)',
  'SELECT 1'
);

PREPARE stmt_add_idx FROM @sql_add_idx;
EXECUTE stmt_add_idx;
DEALLOCATE PREPARE stmt_add_idx;
