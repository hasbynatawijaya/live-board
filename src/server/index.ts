import { startBoardServer } from "./server";

const port = Number(process.env.PORT ?? 1234);
const dataDir = process.env.DATA_DIR ?? "./data";

const server = await startBoardServer({ port, dataDir });
console.log(`Live Board sync server on :${server.port}, snapshots in ${dataDir}`);

// Save snapshots before exiting on Ctrl+C or a container stop.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await server.close();
    process.exit(0);
  });
}
