import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";

await applyD1Migrations(env.DB, (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);

// Embeddings use a fake model and an in-memory index in every test (never Cloudflare)
import { setEmbedder, setVectorStore } from "../src/vectors/embed";
import { fakeEmbedder, memoryStore } from "./fake-vectors";
setEmbedder(fakeEmbedder);
setVectorStore(() => memoryStore);
