import { defineConfig, devices } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";

export default defineConfig({
  testDir: "e2e",
  use: { baseURL: "http://localhost:4190" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "npm run server",
      url: "http://localhost:1234/health",
      env: { PORT: "1234", DATA_DIR: join(tmpdir(), `live-board-e2e-${Date.now()}`) },
      reuseExistingServer: false,
    },
    {
      command: "npm run build && npx vite preview --port 4190 --strictPort",
      url: "http://localhost:4190",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
