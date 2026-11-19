# The Node build of Vault in a container: the same tools at /mcp, with the database in a volume.
#
#   docker build -t vault .
#   docker run -d --name vault -p 8788:8788 -v vault-data:/data --env-file .env vault
#
# Settings come from the environment (see .env.example). The database, the meaning index and the
# sign-in store live in /data, so keep that volume and back it up.
FROM node:24-slim

WORKDIR /app
ENV NODE_ENV=production

# Dependencies first, so rebuilding after a code change is quick. tsx (which runs the TypeScript
# as it is) is a dev dependency, so those are installed too.
COPY package.json package-lock.json ./
RUN npm ci --include=dev && npm cache clean --force

COPY tsconfig.json worker-configuration.d.ts ./
COPY migrations ./migrations
COPY src ./src
COPY node ./node

# Inside a container the server must listen on every interface; publish the port only where you mean to
ENV HOST=0.0.0.0 PORT=8788 VAULT_DB=/data/vault.db
RUN mkdir /data && chown node:node /data
VOLUME /data
USER node
EXPOSE 8788

CMD ["node_modules/.bin/tsx", "node/server.ts"]
