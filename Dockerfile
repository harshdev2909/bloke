# One image for every TypeScript service; pick one with SERVICE=api|indexer|oracle-pusher|keeper.
FROM node:24-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages ./packages
COPY services ./services
COPY tests ./tests
RUN pnpm install --frozen-lockfile && pnpm -r --filter "./packages/*" --filter "./services/*" build

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
COPY db ./db
COPY contracts/deployments ./contracts/deployments
ARG SERVICE=api
ENV SERVICE=${SERVICE}
USER node
CMD ["sh", "-c", "node services/${SERVICE}/dist/main.js"]
