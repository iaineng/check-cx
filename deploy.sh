#!/bin/bash
set -e

echo "=== 拉取最新代码 ==="
git pull

echo "=== 构建新镜像（不停机）==="
docker compose build

echo "=== 替换容器 ==="
docker compose up -d --force-recreate --remove-orphans

echo "=== 等待服务就绪 ==="
sleep 5

echo "=== 检查服务状态 ==="
if curl -s -o /dev/null -w "%{http_code}" http://localhost:3000 | grep -q "200"; then
    echo "服务正常运行"
else
    echo "警告: 服务可能未就绪，请检查日志"
    docker logs check-cx --tail 20
fi

echo "=== 清理旧镜像 ==="
docker image prune -f

echo "=== 部署完成 ==="
