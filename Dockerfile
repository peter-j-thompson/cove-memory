# Open Memory Database: Postgres 18 + Apache AGE (graph) + pgvector (embeddings)
# Open Memory Database — Postgres 18 + Apache AGE + pgvector

FROM apache/age:latest

USER root

# Install build dependencies + CA certs for git clone
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ca-certificates \
      build-essential \
      git \
      postgresql-server-dev-18 \
    && rm -rf /var/lib/apt/lists/*

# Build and install pgvector from source
RUN cd /tmp && \
    git clone --branch v0.8.2 https://github.com/pgvector/pgvector.git && \
    cd pgvector && \
    make OPTFLAGS="" && \
    make install && \
    rm -rf /tmp/pgvector

# Clean up build deps
RUN apt-get purge -y build-essential git && \
    apt-get autoremove -y && \
    rm -rf /var/lib/apt/lists/*

USER postgres
