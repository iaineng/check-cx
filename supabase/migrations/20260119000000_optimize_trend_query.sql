-- =============================================================================
-- 迁移：优化趋势数据查询性能 (public schema)
--
-- 问题：get_check_history_by_time 返回全量数据（7天约23万条），导致 API 响应慢
-- 方案：在数据库层面进行智能采样，每个 config 最多返回 500 个点
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. 删除旧版本函数（2个参数的版本）
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.get_check_history_by_time(interval, uuid[]);

-- -----------------------------------------------------------------------------
-- 2. 创建优化版本的趋势数据查询函数（带采样）
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_check_history_by_time(
    since_interval interval DEFAULT '1 hour',
    target_config_ids uuid[] DEFAULT NULL,
    max_points_per_config integer DEFAULT 500
)
RETURNS TABLE (
    config_id       uuid,
    status          text,
    latency_ms      integer,
    checked_at      timestamptz
)
LANGUAGE sql
STABLE
AS $$
    WITH ranked_history AS (
        SELECT
            h.config_id,
            h.status,
            h.latency_ms,
            h.checked_at,
            ROW_NUMBER() OVER (PARTITION BY h.config_id ORDER BY h.checked_at ASC) AS rn,
            COUNT(*) OVER (PARTITION BY h.config_id) AS total_count
        FROM public.check_history h
        WHERE h.checked_at > NOW() - since_interval
          AND (target_config_ids IS NULL OR h.config_id = ANY(target_config_ids))
    ),
    sampled AS (
        SELECT
            config_id,
            status,
            latency_ms,
            checked_at,
            rn,
            total_count,
            -- 计算采样步长：如果总数超过 max_points，则需要跳过一些点
            GREATEST(1, total_count / max_points_per_config) AS step
        FROM ranked_history
    )
    SELECT
        config_id,
        status,
        latency_ms,
        checked_at
    FROM sampled
    WHERE
        -- 保留首尾点
        rn = 1 OR rn = total_count
        -- 或者按步长采样
        OR (rn - 1) % step = 0
    ORDER BY config_id, checked_at ASC;
$$;

COMMENT ON FUNCTION public.get_check_history_by_time IS '按时间范围查询历史记录（带采样优化，每个 config 最多返回 max_points_per_config 条）';

-- -----------------------------------------------------------------------------
-- 3. 添加针对 checked_at 的单列索引（如果不存在）
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_history_checked_at
ON public.check_history (checked_at DESC);
