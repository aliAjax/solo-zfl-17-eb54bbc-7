module.exports = {
  testDir: ".",
  timeout: 30000,
  fullyParallel: false,
  workers: 1,
  use: { browserName: "chromium", headless: true },
  retries: 0
};
