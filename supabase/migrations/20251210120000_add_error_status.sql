-- 添加 error 状态到 check_history.status 枚举约束
-- 用于区分请求异常（网络错误、API 报错、连接失败）的情况

-- 删除旧的约束 (可能是 check_status_enum 或 check_status_valid)
ALTER TABLE public.check_history DROP CONSTRAINT IF EXISTS check_status_enum;
ALTER TABLE public.check_history DROP CONSTRAINT IF EXISTS check_status_valid;

-- 添加新的约束,包含 error
ALTER TABLE public.check_history
ADD CONSTRAINT check_status_valid
CHECK (status IN ('operational', 'degraded', 'failed', 'validation_failed', 'error'));

-- 更新注释
COMMENT ON COLUMN public.check_history.status IS '状态: operational, degraded, failed, validation_failed, error';
