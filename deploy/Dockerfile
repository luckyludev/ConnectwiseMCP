FROM node:20-slim

# Python tooling for mcpo in a venv
RUN apt-get update \
  && apt-get install -y python3 python3-venv python3-pip \
  && rm -rf /var/lib/apt/lists/*

# Create venv and install mcpo there
RUN python3 -m venv /opt/venv \
  && /opt/venv/bin/pip install --upgrade pip setuptools wheel \
  && /opt/venv/bin/pip install mcpo

ENV PATH="/opt/venv/bin:${PATH}"

WORKDIR /app

# Copy your MCP server code into the image (must exist in build context)
COPY ./cwm-mcp /app/mcp-server

# Copy mcpo config
COPY ./config.json /app/config.json

EXPOSE 8000

CMD ["sh", "-c", "mcpo --host 0.0.0.0 --port 8000 --api-key \"$MCPO_API_KEY\" --config /app/config.json"]
