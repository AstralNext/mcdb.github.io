FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py .
# 构建镜像时把 api/v1/semantic 挂到 /data，或运行时 -e MCDB_SEMANTIC_DIR
ENV MCDB_SEMANTIC_DIR=/data
EXPOSE 8080
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8080"]
