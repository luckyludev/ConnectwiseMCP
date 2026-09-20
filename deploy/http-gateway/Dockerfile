FROM python:3.12-slim@sha256:78387bc3881b8273120a12ebe6c1ab22b018ccc2c9adf565ae1ac9b536e184ea

WORKDIR /app

COPY http-gateway/requirements.lock /app/requirements.lock
RUN pip install --no-cache-dir --require-hashes -r /app/requirements.lock \
  && groupadd --gid 10001 app \
  && useradd --uid 10001 --gid app --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin app

# Copy only the MCP modules and database required by the rollback gateway. Keep
# the writable legacy database under app-user ownership without broad COPYs
# that could embed local credentials, logs, backups, or other workspace files.
COPY --chown=app:app \
  cwm-mcp/api_gateway/__init__.py \
  cwm-mcp/api_gateway/api_db_utils.py \
  cwm-mcp/api_gateway/connectwise_api.db \
  cwm-mcp/api_gateway/fast_memory_db.py \
  cwm-mcp/api_gateway/server.py \
  /app/mcp-server/api_gateway/
COPY --chown=app:app http-gateway/app/main.py /app/gateway/main.py

# Default env for module discovery
ENV PYTHONPATH="/app/mcp-server"

EXPOSE 8000

USER 10001:10001

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:8000/health', timeout=5).read()"]

CMD ["python", "-m", "uvicorn", "gateway.main:app", "--host", "0.0.0.0", "--port", "8000"]
