const { createPool, migrate } = require("./db");
const { createApp } = require("./app");
const { seedIfEmpty } = require("./seed");

async function main() {
  const { DATABASE_URL, API_KEY, PORT = 3000 } = process.env;
  if (!DATABASE_URL) throw new Error("DATABASE_URL must be set");
  if (!API_KEY) throw new Error("API_KEY must be set");

  const pool = createPool(DATABASE_URL);
  await migrate(pool);
  if (process.env.SEED_DEMO_SLOTS !== "false") await seedIfEmpty(pool);

  createApp({ pool, apiKey: API_KEY }).listen(PORT, () => {
    console.log(`Clinic booking API listening on port ${PORT}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
