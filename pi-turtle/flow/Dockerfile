FROM node:22-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv curl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:${PATH}"
WORKDIR /app
COPY . .
RUN ./fetch-mcp-v8.sh
RUN cd pi-turtle/flow && npm install --no-audit --no-fund
ENV TURTLE_PORT=8790
CMD ["bash", "pi-turtle/flow/start.sh"]
