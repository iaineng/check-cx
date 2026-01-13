-- =============================================================================
-- 迁移：dev schema 扩展历史数据留存与可用性统计
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. 添加复合索引（优化时间范围查询）
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_dev_history_config_checked
ON dev.check_history (config_id, checked_at DESC);

-- -----------------------------------------------------------------------------
-- 2. 创建可用性统计视图
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW dev.availability_stats AS
SELECT
    config_id,
    '7d'::text AS period,
    COUNT(*) AS total_checks,
    COUNT(*) FILTER (WHERE status = 'operational') AS operational_count,
    ROUND(
        100.0 * COUNT(*) FILTER (WHERE status = 'operational') / NULLIF(COUNT(*), 0),
        2
    ) AS availability_pct
FROM dev.check_history
WHERE checked_at > NOW() - INTERVAL '7 days'
GROUP BY config_id

UNION ALL

SELECT
    config_id,
    '15d'::text AS period,
    COUNT(*) AS total_checks,
    COUNT(*) FILTER (WHERE status = 'operational') AS operational_count,
    ROUND(
        100.0 * COUNT(*) FILTER (WHERE status = 'operational') / NULLIF(COUNT(*), 0),
        2
    ) AS availability_pct
FROM dev.check_history
WHERE checked_at > NOW() - INTERVAL '15 days'
GROUP BY config_id

UNION ALL

SELECT
    config_id,
    '30d'::text AS period,
    COUNT(*) AS total_checks,
    COUNT(*) FILTER (WHERE status = 'operational') AS operational_count,
    ROUND(
        100.0 * COUNT(*) FILTER (WHERE status = 'operational') / NULLIF(COUNT(*), 0),
        2
    ) AS availability_pct
FROM dev.check_history
WHERE checked_at > NOW() - INTERVAL '30 days'
GROUP BY config_id;

-- -----------------------------------------------------------------------------
-- 3. 修改清理函数：从按数量改为按时间（保留兼容参数）
-- -----------------------------------------------------------------------------
-- 先删除旧版本函数（单参数版本），避免函数重载冲突
DROP FUNCTION IF EXISTS dev.prune_check_history(integer);

CREATE OR REPLACE FUNCTION dev.prune_check_history(
  retention_days integer DEFAULT NULL,
  limit_per_config integer DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  effective_days integer;
  deleted_count integer;
BEGIN
  effective_days := LEAST(365, GREATEST(7, COALESCE(retention_days, limit_per_config, 30)));

  DELETE FROM dev.check_history
  WHERE checked_at < NOW() - (effective_days || ' days')::interval;

  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

-- -----------------------------------------------------------------------------
-- 4. 新增按时间范围查询历史的函数
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION dev.get_check_history_by_time(
  since_interval interval DEFAULT '1 hour',
  target_config_ids uuid[] DEFAULT NULL
)
RETURNS TABLE (
  config_id uuid,
  status text,
  latency_ms integer,
  ping_latency_ms integer,
  checked_at timestamptz,
  message text,
  name text,
  type text,
  model text,
  endpoint text,
  group_name text
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    h.config_id,
    h.status,
    h.latency_ms,
    h.ping_latency_ms::integer,
    h.checked_at,
    h.message,
    c.name,
    c.type::text,
    c.model,
    c.endpoint,
    c.group_name
  FROM dev.check_history h
  JOIN dev.check_configs c ON c.id = h.config_id
  WHERE h.checked_at > NOW() - since_interval
    AND (target_config_ids IS NULL OR h.config_id = ANY(target_config_ids))
  ORDER BY c.name ASC, h.checked_at DESC;
$$;
