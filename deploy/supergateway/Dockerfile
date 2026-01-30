FROM node:20-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-venv python3-pip ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g supergateway
RUN ln -s /usr/bin/python3 /usr/local/bin/python

# venv avoids PEP668 / externally-managed issues
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
ENV PYTHONUNBUFFERED=1

WORKDIR /app
COPY cwm-mcp /app/mcp-server
WORKDIR /app/mcp-server

RUN pip install --no-cache-dir -r requirements.txt

WORKDIR /app
