# Minimal non-root container for MCP directory introspection (Glama / HOL Registry)
FROM node:22-alpine

WORKDIR /app

COPY --chown=node:node package.json plugin.json mcp_config.json hooks.json LICENSE THIRD_PARTY_NOTICES.md ./
COPY --chown=node:node fast ./fast
COPY --chown=node:node context ./context
COPY --chown=node:node hooks ./hooks
COPY --chown=node:node rules ./rules
COPY --chown=node:node skills ./skills

RUN mkdir -p /workspace && chown node:node /workspace

USER node
WORKDIR /workspace

ENTRYPOINT ["node", "/app/fast/mcp-server.mjs"]
