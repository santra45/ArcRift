// Point settings at a path that does not exist, so every suite resolves the
// built-in defaults (Ollama) rather than the developer's saved configuration.
// Without this, switching the dashboard to a cloud provider made the
// integration tests embed through that provider — and bill for it.
process.env.ARCRIFT_SETTINGS_PATH = require("path").join(__dirname, "ArcRift-settings.test-absent.json");
