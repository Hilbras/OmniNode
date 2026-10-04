# Local runtime for OmniNode (local-first: no cloud service required).
# Build: docker build -t omninode .
# Run:   docker run --rm -v "$PWD:/work" -w /work omninode run my-pipeline "audit the repo"
FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts=false && npm cache clean --force

COPY dist ./dist
RUN npm link || true

WORKDIR /work
ENTRYPOINT ["omninode"]
CMD ["--help"]