FROM python:3.12-slim@sha256:78387bc3881b8273120a12ebe6c1ab22b018ccc2c9adf565ae1ac9b536e184ea

WORKDIR /app

COPY http-gateway/requirements.lock /app/requirements.lock
RUN pip install --no-cache-dir --require-hashes -r /app/requirements.lock \
  && groupadd --gid 10001 app \
  && useradd --uid 10001 --gid app --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin app

# Copy MCP server code and gateway app. The legacy server writes its rollback
# database beside its source, so retain app-user ownership without root runtime.
COPY --chown=app:app cwm-mcp /app/mcp-server
COPY --chown=app:app http-gateway/app /app/gateway

# Default env for module discovery
ENV PYTHONPATH="/app/mcp-server"

EXPOSE 8000

USER 10001:10001

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:8000/health', timeout=5).read()"]

CMD ["python", "-m", "uvicorn", "gateway.main:app", "--host", "0.0.0.0", "--port", "8000"]
